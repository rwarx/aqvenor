using System.Text;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Application.Services.Tools;

/// <summary>
/// Joins nodes on the shared canvas with edges: the model wiring up the map it is building.
/// </summary>
/// <remarks>
/// <see cref="AgentToolRisk.Read"/> like its siblings — canvas state, not the user's machine.
/// Endpoints are checked against the current graph so a typo'd id comes back as a sentence the
/// model can fix, rather than a silently dropped edge. Edge ids are derived from the pair, so
/// re-sending the same link is a no-op rather than a second line.
/// </remarks>
public sealed class LinkNodesTool : IAgentTool
{
    private const int MaxEdges = 60;

    private readonly IGraphService _graph;

    public LinkNodesTool(IGraphService graph)
    {
        ArgumentNullException.ThrowIfNull(graph);
        _graph = graph;
    }

    public string Name => "link_nodes";

    public string Description =>
        "Draws edges between nodes already on the canvas, by their ids. Each edge is directed "
        + "(source → target) and has a 'kind' (contains, depends, calls, implements, relates, plans). "
        + "Both endpoints must already exist — add them with add_nodes first, and use read_canvas to get "
        + "their ids. Draws on the canvas only.";

    public string ParametersJsonSchema =>
        """
        {
          "type": "object",
          "properties": {
            "edges": {
              "type": "array",
              "description": "The links to draw. At least one.",
              "items": {
                "type": "object",
                "properties": {
                  "sourceId": { "type": "string", "description": "Id of the node the relationship starts from." },
                  "targetId": { "type": "string", "description": "Id of the node it points at." },
                  "kind": {
                    "type": "string",
                    "description": "What the relationship asserts. Defaults to 'relates'.",
                    "enum": ["contains","depends","calls","implements","relates","plans"]
                  },
                  "label": { "type": "string", "description": "Short text along the edge when the kind is not enough." }
                },
                "required": ["sourceId", "targetId"]
              }
            }
          },
          "required": ["edges"]
        }
        """;

    public AgentToolRisk Risk => AgentToolRisk.Read;

    public async Task<AgentToolResult> ExecuteAsync(
        AgentToolArguments arguments,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        if (!arguments.TryGetObjectArray("edges", out var raw, out var error))
        {
            return AgentToolResult.Fail(error, $"{Name}: rejected");
        }

        if (raw.Count == 0)
        {
            return AgentToolResult.Fail("'edges' is required and must hold at least one edge.", $"{Name}: rejected");
        }

        if (raw.Count > MaxEdges)
        {
            return AgentToolResult.Fail(
                $"That is {raw.Count} edges in one call; add no more than {MaxEdges} at a time.", $"{Name}: rejected");
        }

        var snapshot = _graph.Current;
        var changes = new List<GraphChange>(raw.Count);
        var skipped = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var item in raw)
        {
            if (!item.TryGetString("sourceId", out var source, out var sourceError))
            {
                return AgentToolResult.Fail($"Every edge needs a 'sourceId': {sourceError}", $"{Name}: rejected");
            }

            if (!item.TryGetString("targetId", out var target, out var targetError))
            {
                return AgentToolResult.Fail($"Every edge needs a 'targetId': {targetError}", $"{Name}: rejected");
            }

            source = source.Trim();
            target = target.Trim();

            if (string.Equals(source, target, StringComparison.Ordinal))
            {
                skipped.Add($"{source} → {target} (a node cannot link to itself)");
                continue;
            }

            if (!snapshot.TryGetNode(source, out _))
            {
                skipped.Add($"{source} → {target} (no node '{source}' — add it first)");
                continue;
            }

            if (!snapshot.TryGetNode(target, out _))
            {
                skipped.Add($"{source} → {target} (no node '{target}' — add it first)");
                continue;
            }

            var id = $"ae:{source}>{target}";
            if (!seen.Add(id))
            {
                continue; // same pair twice in one call — draw once
            }

            changes.Add(new AddEdge(new GraphEdge
            {
                Id = id,
                SourceId = source,
                TargetId = target,
                Kind = ParseKind(item.GetString("kind")),
                Label = item.GetString("label"),
            }));
        }

        var result = changes.Count == 0
            ? null
            : await _graph.ApplyAsync(
                new GraphChangeSet
                {
                    Title = $"Agent linked {changes.Count} edge(s)",
                    Origin = GraphChangeOrigin.Agent,
                    Changes = changes,
                },
                cancellationToken).ConfigureAwait(false);

        var applied = result?.Applied.Count ?? 0;
        var report = new StringBuilder();
        report.Append("Linked ").Append(applied).Append(" edge(s).");
        if (result is { Rejected.Count: > 0 })
        {
            report.Append('\n').Append(result.Rejected.Count).Append(" rejected by the graph:\n- ")
                .Append(string.Join("\n- ", result.Rejected));
        }
        if (skipped.Count > 0)
        {
            report.Append('\n').Append(skipped.Count).Append(" skipped:\n- ").Append(string.Join("\n- ", skipped));
        }

        return AgentToolResult.Ok(report.ToString(), $"link_nodes: {applied} linked");
    }

    private static GraphEdgeKind ParseKind(string? raw) =>
        !string.IsNullOrWhiteSpace(raw) && Enum.TryParse<GraphEdgeKind>(raw.Trim(), ignoreCase: true, out var kind)
            ? kind
            : GraphEdgeKind.Relates;
}

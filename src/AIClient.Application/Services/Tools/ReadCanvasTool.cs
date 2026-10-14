using System.Text;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Application.Services.Tools;

/// <summary>
/// The model's eyes on the shared canvas: reads the graph it (and the user, and the indexer)
/// are all drawing on.
/// </summary>
/// <remarks>
/// <see cref="AgentToolRisk.Read"/> — it changes nothing, so it is offered in every mode and
/// never prompts, exactly like reading a file. It is the companion to <c>add_nodes</c> /
/// <c>link_nodes</c>: a model builds the graph up sensibly only if it can first see what is
/// already there (node ids especially, since that is what links refer to).
/// </remarks>
public sealed class ReadCanvasTool : IAgentTool
{
    private const int MaxRows = 300;
    private const int MaxDetailChars = 500;

    private readonly IGraphService _graph;

    public ReadCanvasTool(IGraphService graph)
    {
        ArgumentNullException.ThrowIfNull(graph);
        _graph = graph;
    }

    public string Name => "read_canvas";

    public string Description =>
        "Reads the shared canvas graph — the spatial map of the project that you, the user and the "
        + "workspace indexer all draw on. Lists every node (its id, kind, title, subtitle, path, status "
        + "and note/detail text) and every edge "
        + "(which nodes it joins and how). Call it before add_nodes or link_nodes so you reuse the ids "
        + "that already exist and build on the current drawing instead of duplicating it. Reads only.";

    public string ParametersJsonSchema => """{ "type": "object", "properties": {} }""";

    public AgentToolRisk Risk => AgentToolRisk.Read;

    public Task<AgentToolResult> ExecuteAsync(
        AgentToolArguments arguments,
        CancellationToken cancellationToken = default)
    {
        var snapshot = _graph.Current;

        if (snapshot.Nodes.Count == 0)
        {
            return Task.FromResult(AgentToolResult.Ok(
                "The canvas is empty — there are no nodes yet. Use add_nodes to draw the first ones.",
                "read_canvas: empty"));
        }

        var text = new StringBuilder();
        text.Append("Canvas: ").Append(snapshot.Nodes.Count).Append(" node(s), ")
            .Append(snapshot.Edges.Count).Append(" edge(s).\n\nNodes:\n");

        foreach (var node in snapshot.Nodes.Take(MaxRows))
        {
            text.Append("- ").Append(node.Id).Append(" · ").Append(node.Kind.ToString().ToLowerInvariant())
                .Append(" · ").Append(node.Title);
            if (!string.IsNullOrWhiteSpace(node.Subtitle))
            {
                text.Append(" — ").Append(Clean(node.Subtitle));
            }

            if (!string.IsNullOrWhiteSpace(node.Path)
                && !string.Equals(node.Path.Trim(), node.Subtitle?.Trim(), StringComparison.Ordinal))
            {
                text.Append(" [path: ").Append(Clean(node.Path)).Append(']');
            }

            if (node.Status != GraphNodeState.None)
            {
                text.Append(" [status: ").Append(node.Status.ToString().ToLowerInvariant()).Append(']');
            }

            text.Append('\n');

            if (!string.IsNullOrWhiteSpace(node.Detail))
            {
                text.Append("  note: ").Append(Truncate(Clean(node.Detail))).Append('\n');
            }
        }

        if (snapshot.Edges.Count > 0)
        {
            text.Append("\nEdges:\n");
            foreach (var edge in snapshot.Edges.Take(MaxRows))
            {
                text.Append("- ").Append(edge.SourceId).Append(" → ").Append(edge.TargetId)
                    .Append(" (").Append(edge.Kind.ToString().ToLowerInvariant()).Append(')');
                if (!string.IsNullOrWhiteSpace(edge.Label))
                {
                    text.Append(" : ").Append(Truncate(Clean(edge.Label)));
                }

                text.Append('\n');
            }
        }

        if (snapshot.Nodes.Count > MaxRows || snapshot.Edges.Count > MaxRows)
        {
            text.Append("\n(…truncated to the first ").Append(MaxRows).Append(" of each.)");
        }

        return Task.FromResult(AgentToolResult.Ok(
            text.ToString(),
            $"read_canvas: {snapshot.Nodes.Count} node(s), {snapshot.Edges.Count} edge(s)"));
    }

    private static string Clean(string text) =>
        text.Replace('\r', ' ').Replace('\n', ' ').Trim();

    private static string Truncate(string text) =>
        text.Length <= MaxDetailChars ? text : text[..MaxDetailChars] + "… (truncated)";
}

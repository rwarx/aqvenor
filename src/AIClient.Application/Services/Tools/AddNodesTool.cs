using System.Text;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Application.Services.Tools;

/// <summary>
/// Draws nodes onto the shared canvas: the model building up the spatial map a piece at a time,
/// the incremental companion to the whole-plan <c>submit_plan</c>.
/// </summary>
/// <remarks>
/// <see cref="AgentToolRisk.Read"/> for the same reason <c>submit_plan</c> is — it writes app
/// state (the canvas), not the user's machine, so an approval dialog in front of a drawing the
/// user asked for would be noise. Ids are minted under an <c>agent:</c> prefix when the model
/// does not give one, which also keeps them out of the <c>ws/dir:/file:</c> families the
/// workspace indexer owns, so a reindex never deletes a node the agent drew.
/// </remarks>
public sealed class AddNodesTool : IAgentTool
{
    private const int MaxNodes = 40;

    /// <summary>Id families minted by the workspace indexer; the agent must not claim them.</summary>
    private static readonly string[] ReservedPrefixes = ["ws", "dir:", "file:", "c:"];

    private readonly IGraphService _graph;

    public AddNodesTool(IGraphService graph)
    {
        ArgumentNullException.ThrowIfNull(graph);
        _graph = graph;
    }

    public string Name => "add_nodes";

    public string Description =>
        "Adds one or more nodes to the shared canvas graph. Each node has a 'kind' (its colour/icon) "
        + "and a 'title'. Give a node an 'id' if you want to link to it later with link_nodes — otherwise "
        + "one is generated and returned to you. Omit x/y to let the nodes be auto-placed beside what is "
        + "already there. Call read_canvas first to avoid duplicating existing nodes. Draws on the canvas "
        + "only; creates, changes and runs nothing on disk.";

    public string ParametersJsonSchema =>
        """
        {
          "type": "object",
          "properties": {
            "nodes": {
              "type": "array",
              "description": "The nodes to draw. At least one.",
              "items": {
                "type": "object",
                "properties": {
                  "id": { "type": "string", "description": "Optional stable id to link to later. Generated if omitted." },
                  "kind": {
                    "type": "string",
                    "description": "What the node is, roughly.",
                    "enum": ["note","file","folder","module","service","interface","data","view","test","plan","task","agent","model","external"]
                  },
                  "title": { "type": "string", "description": "The one line the node is drawn and referred to by." },
                  "subtitle": { "type": "string", "description": "A dimmer second line: a kind, a count, a hint." },
                  "detail": { "type": "string", "description": "Longer text shown when the node is opened." },
                  "x": { "type": "number", "description": "Canvas X (centre). Omit to auto-place." },
                  "y": { "type": "number", "description": "Canvas Y (centre). Omit to auto-place." }
                },
                "required": ["title"]
              }
            }
          },
          "required": ["nodes"]
        }
        """;

    public AgentToolRisk Risk => AgentToolRisk.Read;

    public async Task<AgentToolResult> ExecuteAsync(
        AgentToolArguments arguments,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        if (!arguments.TryGetObjectArray("nodes", out var raw, out var error))
        {
            return AgentToolResult.Fail(error, $"{Name}: rejected");
        }

        if (raw.Count == 0)
        {
            return AgentToolResult.Fail("'nodes' is required and must hold at least one node.", $"{Name}: rejected");
        }

        if (raw.Count > MaxNodes)
        {
            return AgentToolResult.Fail(
                $"That is {raw.Count} nodes in one call; add no more than {MaxNodes} at a time.", $"{Name}: rejected");
        }

        var snapshot = _graph.Current;
        var baseX = snapshot.Nodes.Count == 0 ? 0 : snapshot.Nodes.Max(n => n.X) + 320;
        var used = new HashSet<string>(StringComparer.Ordinal);
        var changes = new List<GraphChange>(raw.Count);
        var mintedIds = new List<string>(raw.Count);
        var row = 0;

        foreach (var item in raw)
        {
            if (!item.TryGetString("title", out var title, out var titleError))
            {
                return AgentToolResult.Fail($"Every node needs a 'title': {titleError}", $"{Name}: rejected");
            }

            var requestedId = item.GetString("id");
            if (!string.IsNullOrWhiteSpace(requestedId)
                && ReservedPrefixes.Any(p => requestedId.StartsWith(p, StringComparison.Ordinal)))
            {
                return AgentToolResult.Fail(
                    $"The id '{requestedId}' uses a reserved prefix (ws/dir:/file:/c:). Leave 'id' out or choose another.",
                    $"{Name}: rejected");
            }

            var id = string.IsNullOrWhiteSpace(requestedId)
                ? $"agent:{Guid.NewGuid():N}"[..14]
                : requestedId.Trim();

            if (!used.Add(id))
            {
                return AgentToolResult.Fail($"The id '{id}' is used twice in this call.", $"{Name}: rejected");
            }

            if (!item.TryGetInt32("x", out var x, out var xError))
            {
                return AgentToolResult.Fail(xError, $"{Name}: rejected");
            }

            if (!item.TryGetInt32("y", out var y, out var yError))
            {
                return AgentToolResult.Fail(yError, $"{Name}: rejected");
            }

            changes.Add(new AddNode(new GraphNode
            {
                Id = id,
                Kind = ParseKind(item.GetString("kind")),
                Title = title,
                Subtitle = item.GetString("subtitle"),
                Detail = item.GetString("detail"),
                X = x ?? baseX,
                Y = y ?? row * 120,
            }));
            mintedIds.Add(id);
            row++;
        }

        var result = await _graph.ApplyAsync(
            new GraphChangeSet
            {
                Title = $"Agent drew {changes.Count} node(s)",
                Origin = GraphChangeOrigin.Agent,
                Changes = changes,
            },
            cancellationToken).ConfigureAwait(false);

        var report = new StringBuilder();
        report.Append("Added ").Append(result.Applied.Count).Append(" node(s): ")
            .Append(string.Join(", ", mintedIds)).Append('.');
        if (result.Rejected.Count > 0)
        {
            report.Append('\n').Append(result.Rejected.Count).Append(" rejected:\n- ")
                .Append(string.Join("\n- ", result.Rejected));
        }

        return AgentToolResult.Ok(report.ToString(), $"add_nodes: {result.Applied.Count} added");
    }

    private static GraphNodeKind ParseKind(string? raw) =>
        !string.IsNullOrWhiteSpace(raw) && Enum.TryParse<GraphNodeKind>(raw.Trim(), ignoreCase: true, out var kind)
            ? kind
            : GraphNodeKind.Note;
}

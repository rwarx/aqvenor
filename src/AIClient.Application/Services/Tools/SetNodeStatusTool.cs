using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Application.Services.Tools;

/// <summary>
/// Marks how the work a canvas node stands for is going: pending / running / done / failed.
/// </summary>
/// <remarks>
/// <see cref="AgentToolRisk.Read"/> like the other canvas tools — it writes the drawing, not the
/// user's machine. Lets the agent show progress on a task or plan node as it works: mark a node
/// <c>running</c> when it starts on it and <c>done</c> when it finishes, so the canvas reads as a
/// live board rather than a static sketch.
/// </remarks>
public sealed class SetNodeStatusTool : IAgentTool
{
    private readonly IGraphService _graph;

    public SetNodeStatusTool(IGraphService graph)
    {
        ArgumentNullException.ThrowIfNull(graph);
        _graph = graph;
    }

    public string Name => "set_node_status";

    public string Description =>
        "Sets the progress status of a node already on the canvas, by its id: 'pending', 'running', "
        + "'done' or 'failed' (or 'none' to clear it). Use it to show progress as you work — mark a "
        + "task node 'running' when you start it and 'done' when it is finished. Use read_canvas to find "
        + "node ids. Draws on the canvas only.";

    public string ParametersJsonSchema =>
        """
        {
          "type": "object",
          "properties": {
            "nodeId": { "type": "string", "description": "Id of the node to mark." },
            "status": {
              "type": "string",
              "description": "The progress status.",
              "enum": ["none", "pending", "running", "done", "failed"]
            }
          },
          "required": ["nodeId", "status"]
        }
        """;

    public AgentToolRisk Risk => AgentToolRisk.Read;

    public async Task<AgentToolResult> ExecuteAsync(
        AgentToolArguments arguments,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        if (!arguments.TryGetString("nodeId", out var nodeId, out var idError))
        {
            return AgentToolResult.Fail(idError, $"{Name}: rejected");
        }

        if (!arguments.TryGetString("status", out var statusText, out var statusError))
        {
            return AgentToolResult.Fail(statusError, $"{Name}: rejected");
        }

        if (!Enum.TryParse<GraphNodeState>(statusText.Trim(), ignoreCase: true, out var status))
        {
            return AgentToolResult.Fail(
                $"'{statusText}' is not a status. Use none, pending, running, done or failed.", $"{Name}: rejected");
        }

        nodeId = nodeId.Trim();
        if (!_graph.Current.TryGetNode(nodeId, out _))
        {
            return AgentToolResult.Fail(
                $"There is no node '{nodeId}' on the canvas. Call read_canvas for the current ids.",
                $"{Name}: rejected");
        }

        var result = await _graph.ApplyAsync(
            new GraphChangeSet
            {
                Title = $"Agent marked a node {status.ToString().ToLowerInvariant()}",
                Origin = GraphChangeOrigin.Agent,
                Changes = [new SetNodeStatus(nodeId, status)],
            },
            cancellationToken).ConfigureAwait(false);

        if (result.Applied.Count == 0 && result.Rejected.Count > 0)
        {
            return AgentToolResult.Fail(result.Rejected[0], $"{Name}: rejected");
        }

        return AgentToolResult.Ok(
            $"Node '{nodeId}' is now {status.ToString().ToLowerInvariant()}.",
            $"set_node_status: {nodeId} → {status.ToString().ToLowerInvariant()}");
    }
}

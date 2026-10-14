namespace AIClient.Domain.Graph;

/// <summary>
/// How a canvas node's work is going — the task status the agent sets with <c>set_node_status</c>.
/// </summary>
/// <remarks>
/// Deliberately distinct from the dormant <c>Enums.GraphNodeStatus</c> (Active/Missing/Archived),
/// which is an *existence* flag on an unrelated knowledge-graph row. This is *progress*: the
/// vocabulary a plan step or a run moves through, so a node drawn for a task can show whether that
/// task is waiting, in flight, finished or broken. Presentation decides the colour; the domain
/// only stores and sorts it. <see cref="None"/> is the default — a node with no status to show.
/// </remarks>
public enum GraphNodeState
{
    /// <summary>No status to show — a plain node.</summary>
    None,

    /// <summary>Queued, not started.</summary>
    Pending,

    /// <summary>In progress right now.</summary>
    Running,

    /// <summary>Finished successfully.</summary>
    Done,

    /// <summary>Attempted and failed.</summary>
    Failed,
}

using AIClient.Application.Interfaces;

namespace AIClient.Server;

/// <summary>Reserves a child conversation under the HTTP parent's cancellation and approval entry.</summary>
public sealed class HttpChildConversationGuard(RunRegistry runs) : IAgentChildConversationGuard
{
    public IDisposable? TryReserve(Guid conversationId) =>
        HttpAgentApproval.CurrentRunId.Value is { } parentRunId
            ? runs.TryReserveChild(parentRunId, conversationId)
            : null;
}

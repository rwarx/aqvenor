namespace AIClient.Application.Interfaces;

/// <summary>Reserves a child transcript under its parent's host run until execution and cleanup finish.</summary>
public interface IAgentChildConversationGuard
{
    IDisposable? TryReserve(Guid conversationId);
}

using AIClient.Application.DTOs;
using AIClient.Application.Services;

namespace AIClient.Application.Interfaces;

/// <summary>A task that the agent loop runs as a bounded child, rather than as a process-wide tool.</summary>
public interface IAgentDelegatingTool : IAgentTool
{
    AgentToolResult? ValidateTask(AgentToolArguments arguments, out string task, out string title);
}

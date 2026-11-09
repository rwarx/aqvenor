using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;

namespace AIClient.Application.Services.Tools;

/// <summary>Describes delegation; the owning agent loop supplies the child lifecycle and cancellation.</summary>
public sealed class DelegateTaskTool(IWorkspaceService workspace, ISettingsService settings)
    : IAgentDelegatingTool, IAgentToolAvailability
{
    public string Name => "delegate_task";
    public string Description =>
        "Delegates one self-contained task to a real subagent using your current model and project. "
        + "Give all needed instructions and context in 'task'; the child gets its own conversation and "
        + "does not inherit your transcript. It uses the same mode and approval rules: planning cannot "
        + "write files, and commands still require approval. Waits for the child and returns its answer, "
        + "status and conversation id. Use for a separate implementation, inspection or test task. "
        + "At most three children per run, twelve model steps per child, and children cannot delegate. "
        + "You remain responsible for checking the result. Stop also cancels the child.";
    public string ParametersJsonSchema => """
        {
          "type":"object",
          "properties":{
            "task":{"type":"string","maxLength":16000,"description":"Complete instructions and relevant context for the child."},
            "title":{"type":"string","maxLength":160,"description":"Short name shown in the child conversation and delegation card."}
          },
          "required":["task"]
        }
        """;

    // Delegation itself only writes app state; every child file change or command has its own gate.
    public AgentToolRisk Risk => AgentToolRisk.Read;
    public bool IsAvailable => settings.Current.Agent.AllowSubagents && workspace.IsOpen;

    public AgentToolResult? ValidateTask(AgentToolArguments arguments, out string task, out string title)
    {
        task = string.Empty;
        title = string.Empty;
        if (!settings.Current.Agent.AllowSubagents)
        {
            return AgentToolResult.Fail("Subagents are switched off in Settings → Agent.", "Delegation is switched off");
        }
        if (!workspace.IsOpen)
        {
            return AgentToolResult.Fail("Open a project folder before delegating work.", "No project is open");
        }
        if (!arguments.TryGetString("task", out var instruction, out var error))
        {
            return AgentToolResult.Fail(error, "Invalid delegated task");
        }
        if (string.IsNullOrWhiteSpace(instruction) || instruction.Length > 16_000)
        {
            return AgentToolResult.Fail("'task' must contain instructions and be at most 16000 characters.", "Invalid delegated task");
        }
        if (!arguments.TryGetOptionalString("title", out var providedTitle, out var titleError))
        {
            return AgentToolResult.Fail(titleError!, "Invalid delegated task title");
        }
        var label = providedTitle?.Trim();
        if (label is { Length: > 160 })
        {
            return AgentToolResult.Fail("'title' must be at most 160 characters.", "Invalid delegated task title");
        }
        task = instruction.Trim();
        var singleLine = task.ReplaceLineEndings(" ");
        title = string.IsNullOrWhiteSpace(label) ? singleLine[..Math.Min(singleLine.Length, 80)] : label;
        return null;
    }

    public Task<AgentToolResult> ExecuteAsync(AgentToolArguments arguments, CancellationToken cancellationToken = default) =>
        Task.FromResult(AgentToolResult.Fail("Delegation requires an active parent agent run.", "No parent agent run"));
}

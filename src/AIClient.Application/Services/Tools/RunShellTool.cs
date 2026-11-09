using System.Text;
using AIClient.Application.Configuration;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;

namespace AIClient.Application.Services.Tools;

/// <summary>Runs an explicitly approved Windows shell script in the selected project.</summary>
public sealed class RunShellTool : WorkspaceTool, IAgentToolPreview, IAgentToolAvailability
{
    // CMD accepts at most 8191 characters. This also leaves room for PowerShell's UTF-16 base64
    // payload within the Windows process command-line limit of 32767 characters.
    private const int MaxScriptCharacters = 7000;
    private readonly ISettingsService _settings;
    private readonly IProcessRunner _runner;

    public RunShellTool(IWorkspaceService workspace, ISettingsService settings, IProcessRunner runner)
        : base(workspace)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(runner);
        _settings = settings;
        _runner = runner;
    }

    public override string Name => "run_shell";
    public override AgentToolRisk Risk => AgentToolRisk.Execute;
    public bool IsAvailable => OperatingSystem.IsWindows()
        && Settings.AllowCommands && Settings.AllowShellCommands && Workspace.IsOpen;
    private AgentSettings Settings => _settings.Current.Agent;

    public override string Description =>
        "Runs a Windows PowerShell or CMD script and returns its output and exit code. "
        + "Use PowerShell for multiline scripts and CMD for single-line Windows command chains joined with & or &&. "
        + "Pipes, redirects, environment variables and command chaining are interpreted by the selected shell. "
        + "The user must enable shell scripts in Settings, and every call requires their approval with the full script. "
        + "working_directory is relative to the open project. This only restricts the starting folder, "
        + "not the script's access to the computer: it is not an OS sandbox. "
        + "Use run_command for a single allowed program when shell features are unnecessary. "
        + "Do not work around a refused command or approval; report what you need and why.";

    public override string ParametersJsonSchema =>
        """
        {
          "type": "object",
          "properties": {
            "shell": {
              "type": "string", "enum": ["powershell", "cmd"],
              "description": "Windows PowerShell or CMD. The app selects the system executable."
            },
            "script": {
              "type": "string", "minLength": 1, "maxLength": 7000,
              "description": "The entire script shown to the user for approval. CMD accepts one line with & or &&; use PowerShell for multiline scripts."
            },
            "working_directory": {
              "type": "string",
              "description": "Starting folder relative to the project root; omit to use the root. This is not an OS sandbox."
            },
            "timeout_seconds": {
              "type": "integer",
              "description": "Seconds before the process tree is stopped, capped by the user's command timeout."
            }
          },
          "required": ["shell", "script"]
        }
        """;

    public override async Task<AgentToolResult> ExecuteAsync(
        AgentToolArguments arguments, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        cancellationToken.ThrowIfCancellationRequested();

        if (Gate() is { } gate)
        {
            return Refuse(gate);
        }

        if (!TryScript(arguments, out var shell, out var script, out var error))
        {
            return Refuse(error);
        }

        if (!arguments.TryGetInt32("timeout_seconds", out var seconds, out var timeoutError))
        {
            return Refuse(timeoutError);
        }

        if (!TryOptionalPath(arguments, "working_directory", out var relative, out var failure))
        {
            return failure;
        }

        var directory = await Workspace.ResolveDirectoryAsync(relative, cancellationToken).ConfigureAwait(false);
        if (!directory.Success)
        {
            return Refuse(directory.Error!);
        }

        // Permission changes while directory resolution was pending must take effect before launch.
        if (Gate() is { } changedGate)
        {
            return Refuse(changedGate);
        }
        var settings = Settings;
        var executable = SystemExecutable(shell);
        if (!File.Exists(executable))
        {
            return Refuse($"The system {shell} executable is unavailable on this computer.");
        }

        var request = new ProcessRunRequest
        {
            FileName = executable,
            WorkingDirectory = directory.Value!,
            Timeout = Timeout(seconds, settings),
            MaxOutputCharacters = Math.Max(1000, settings.MaxCommandOutputCharacters),
        };

        if (shell == "powershell")
        {
            const string prefix = "$ErrorActionPreference='Stop'; "
                + "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
                + "[Console]::InputEncoding=[Console]::OutputEncoding; $OutputEncoding=[Console]::OutputEncoding;\n";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(prefix + script));
            request = request with { Arguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] };
        }
        else
        {
            // CMD does not parse arguments using the normal Windows argv quoting rules. /s strips
            // this outer quote pair; the approved script's own quotes are deliberately untouched.
            request = request with
            {
                WindowsCommandLine = $"/v:off /d /s /c \"chcp 65001>nul & {script}\"",
                CreateHiddenConsole = true,
            };
        }

        var result = await _runner.RunAsync(request, cancellationToken).ConfigureAwait(false);
        if (!result.Started)
        {
            return Refuse(result.Error ?? $"{shell} could not be started.");
        }

        var body = new StringBuilder();
        if (result.TimedOut)
        {
            body.AppendLine($"{shell} timed out after {result.Duration.TotalSeconds:0.#}s and its process tree was stopped. Changes already made remain.");
        }
        else
        {
            body.AppendLine(result.ExitCode == 0
                ? $"Succeeded after {result.Duration.TotalSeconds:0.#}s."
                : $"Failed with exit code {result.ExitCode} after {result.Duration.TotalSeconds:0.#}s.");
        }

        if (result.Truncated)
        {
            body.AppendLine("The output exceeded its limit; the beginning was dropped and the end kept.");
        }

        if (result.Output.Length == 0)
        {
            body.AppendLine("It printed nothing.");
        }
        else
        {
            body.AppendLine().AppendLine("Output:").AppendLine("```").AppendLine(result.Output.TrimEnd()).AppendLine("```");
        }

        var outcome = result.TimedOut ? "timed out" : result.ExitCode == 0 ? "ok" : $"exit {result.ExitCode}";
        return Done(body.ToString().TrimEnd(), $"{Name} {shell} - {outcome}", result.Output);
    }

    public Task<AgentToolPreview> DescribeAsync(AgentToolArguments arguments, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryScript(arguments, out var shell, out var script, out _))
        {
            return Task.FromResult(AgentToolPreview.None);
        }
        arguments.TryGetInt32("timeout_seconds", out var seconds, out _);
        var folder = arguments.GetString("working_directory");
        var where = string.IsNullOrWhiteSpace(folder) || folder is "." or "/" ? "the project root" : folder;
        var summary = $"Run {shell} script in {where}";
        if (Gate() is { } gate)
        {
            summary += $" — {gate}";
        }
        var body = new StringBuilder()
            .Append("Shell: ").AppendLine(shell)
            .Append("Starting folder: ").AppendLine(where)
            .Append("Timeout: ").Append(Timeout(seconds, Settings).TotalSeconds).AppendLine("s")
            .AppendLine()
            .AppendLine("Full script:").AppendLine(script)
            .AppendLine()
            .Append("The folder restriction applies only to where the process starts; it is not an OS sandbox. "
                + "This script can access other folders, change files, run other programs and reach the network. "
                + "Approval applies to this call only.");
        return Task.FromResult(AgentToolPreview.Describe(summary, body.ToString()));
    }

    private string? Gate()
    {
        if (!OperatingSystem.IsWindows())
        {
            return "Windows PowerShell and CMD are available only on Windows.";
        }

        if (!Settings.AllowCommands)
        {
            return "Running programs is switched off in Settings → Agent.";
        }

        if (!Settings.AllowShellCommands)
        {
            return "Shell scripts are switched off in Settings → Agent. The user must enable them explicitly.";
        }

        if (!Workspace.IsOpen)
        {
            return "Open a project folder before running a shell script.";
        }
        return null;
    }

    private static bool TryScript(AgentToolArguments arguments, out string shell, out string script, out string error)
    {
        shell = script = string.Empty;
        if (!arguments.TryGetString("shell", out var rawShell, out var shellError))
        {
            error = shellError;
            return false;
        }

        shell = rawShell.Trim().ToLowerInvariant();
        if (shell is not ("powershell" or "cmd"))
        {
            error = "'shell' must be 'powershell' or 'cmd'; executable paths and other shells are not accepted.";
            return false;
        }

        if (!arguments.TryGetString("script", out var rawScript, out var scriptError))
        {
            error = scriptError;
            return false;
        }

        script = rawScript;
        if (string.IsNullOrWhiteSpace(script) || script.Contains('\0') || script.Length > MaxScriptCharacters)
        {
            error = $"'script' must contain 1–{MaxScriptCharacters} characters, and cannot contain null characters.";
            return false;
        }

        // CMD /c silently stops at a line break and can report success without running later lines.
        if (shell == "cmd" && (script.Contains('\r') || script.Contains('\n')))
        {
            error = "CMD scripts must be a single line. Join commands with '&' or '&&', or select PowerShell for a multiline script.";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static string SystemExecutable(string shell)
    {
        var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        return shell == "cmd"
            ? Path.Combine(system, "cmd.exe")
            : Path.Combine(system, "WindowsPowerShell", "v1.0", "powershell.exe");
    }

    private static TimeSpan Timeout(int? requested, AgentSettings settings)
    {
        var ceiling = settings.CommandTimeoutSeconds > 0 ? settings.CommandTimeoutSeconds : 120;
        var seconds = requested is > 0 ? Math.Min(requested.Value, ceiling) : ceiling;
        return TimeSpan.FromSeconds(seconds);
    }
}

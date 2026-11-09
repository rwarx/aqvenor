using System.Diagnostics;
using System.Text;
using System.Text.Json;
using AIClient.Application.Configuration;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Application.Services;
using AIClient.Application.Services.Tools;
using AIClient.Infrastructure.Configuration;
using AIClient.Infrastructure.Processes;
using AIClient.Infrastructure.Workspace;
using AIClient.Tests.Support;

namespace AIClient.Tests;

public sealed class RunShellToolTests : IAsyncLifetime
{
    private readonly StubSettingsService _settings = new();
    private string _scratch = null!;
    private string _root = null!;
    private WorkspaceService _workspace = null!;
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _scratch = Path.Combine(Path.GetTempPath(), "aiclient-shell", Guid.CreateVersion7().ToString("n"));
        _root = Path.Combine(_scratch, "project");
        Directory.CreateDirectory(Path.Combine(_root, "folder with spaces"));
        _workspace = new WorkspaceService(_settings, new AppPaths(Path.Combine(_scratch, "appdata")),
            new RecordingLogger<WorkspaceService>());
        var opened = await _workspace.OpenAsync(_root, Token);
        Assert.True(opened.Success, opened.Error);
    }

    public ValueTask DisposeAsync()
    {
        // Only delete this test's known, absolute temporary directory.
        if (Directory.Exists(_scratch))
        {
            Directory.Delete(_scratch, recursive: true);
        }

        return ValueTask.CompletedTask;
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task Both_command_and_shell_settings_are_required(bool commands, bool shells)
    {
        var runner = new StubProcessRunner();
        var tool = Tool(runner, commands, shells);
        Assert.False(tool.IsAvailable);
        var result = await Run(tool, "powershell", "Write-Output 'not run'");
        Assert.False(result.Success);
        Assert.Contains("Settings", result.Content, StringComparison.Ordinal);
        Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("commands")]
    [InlineData("shells")]
    public async Task Settings_are_rechecked_after_the_model_was_offered_the_tool(string setting)
    {
        var runner = new StubProcessRunner();
        var tool = Tool(runner);
        Assert.True(tool.IsAvailable);
        _settings.With<AgentSettings>(agent =>
        {
            if (setting == "commands")
            {
                agent.AllowCommands = false;
            }
            else
            {
                agent.AllowShellCommands = false;
            }
        });
        var result = await Run(tool, "cmd", "echo never");
        Assert.False(result.Success);
        Assert.Empty(runner.Requests);
    }

    [Fact]
    public async Task Closing_the_workspace_removes_availability_and_refuses_execution()
    {
        var runner = new StubProcessRunner();
        var tool = Tool(runner);
        await _workspace.CloseAsync(Token);
        Assert.False(tool.IsAvailable);
        Assert.False((await Run(tool, "cmd", "echo never")).Success);
        Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("bash")]
    [InlineData("pwsh")]
    [InlineData("cmd.exe")]
    [InlineData("../cmd")]
    [InlineData("cmd & echo never")]
    public async Task Only_the_two_explicit_shell_identifiers_are_accepted(string shell)
    {
        var runner = new StubProcessRunner();
        var result = await Run(Tool(runner), shell, "echo never");
        Assert.False(result.Success);
        Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("../")]
    [InlineData("C:\\Windows")]
    [InlineData("missing")]
    [InlineData(".git")]
    public async Task The_starting_directory_is_guarded_by_the_workspace(string folder)
    {
        var runner = new StubProcessRunner();
        var result = await Run(Tool(runner), "cmd", "echo never", folder);
        Assert.False(result.Success);
        Assert.Empty(runner.Requests);
    }

    [Fact]
    public async Task PowerShell_uses_the_system_executable_and_preserves_the_entire_Unicode_script()
    {
        var runner = new StubProcessRunner();
        const string script = "Write-Output 'Привет \"мир\" & ; $value'\nWrite-Output 'second'";
        var result = await Run(Tool(runner), "powershell", script, "folder with spaces", 999);
        Assert.True(result.Success, result.Content);
        var request = Assert.Single(runner.Requests);
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe"), request.FileName, ignoreCase: true);
        Assert.Equal(Path.Combine(_root, "folder with spaces"), request.WorkingDirectory);
        Assert.Contains("-NoProfile", request.Arguments);
        Assert.Contains("-NonInteractive", request.Arguments);
        var encodedIndex = request.Arguments.ToList().IndexOf("-EncodedCommand");
        Assert.True(encodedIndex >= 0);
        var decoded = Encoding.Unicode.GetString(Convert.FromBase64String(request.Arguments[encodedIndex + 1]));
        Assert.Contains(script, decoded, StringComparison.Ordinal);
        Assert.Contains("OutputEncoding", decoded, StringComparison.Ordinal);
        Assert.Equal(TimeSpan.FromSeconds(120), request.Timeout);
        Assert.Equal(20_000, request.MaxOutputCharacters);
        Assert.Null(request.WindowsCommandLine);
        Assert.False(request.CreateHiddenConsole);
    }

    [Fact]
    public async Task Cmd_uses_the_trusted_executable_and_keeps_shell_quotes_and_operators_verbatim()
    {
        var runner = new StubProcessRunner();
        const string script = "echo \"quoted & literal\" & echo second >\"with spaces.txt\"";
        Assert.True((await Run(Tool(runner), "cmd", script)).Success);
        var request = Assert.Single(runner.Requests);
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
            request.FileName, ignoreCase: true);
        Assert.Contains(script, request.WindowsCommandLine!, StringComparison.Ordinal);
        Assert.Contains("/d /s /c", request.WindowsCommandLine!, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(request.Arguments);
        Assert.True(request.CreateHiddenConsole);
    }

    [Theory]
    [InlineData(" ")]
    [InlineData("echo before\u0000echo after")]
    public async Task Invalid_scripts_are_refused_before_process_creation(string script)
    {
        var runner = new StubProcessRunner();
        Assert.False((await Run(Tool(runner), "cmd", script)).Success);
        Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("\r")]
    [InlineData("\n")]
    [InlineData("\r\n")]
    public async Task Cmd_newlines_are_refused_instead_of_silently_dropping_later_commands(string newline)
    {
        var runner = new StubProcessRunner();
        var result = await Run(Tool(runner), "cmd", "echo first" + newline + "echo second");
        Assert.False(result.Success, result.Content);
        Assert.Contains("PowerShell", result.Content, StringComparison.Ordinal);
        Assert.Empty(runner.Requests);
    }

    [Fact]
    public async Task A_script_above_the_Windows_command_length_limit_is_refused()
    {
        var runner = new StubProcessRunner();
        Assert.False((await Run(Tool(runner), "powershell", new string('x', 20_000))).Success);
        Assert.Empty(runner.Requests);
    }

    [Fact]
    public async Task Approval_shows_the_full_script_effective_limits_and_the_start_folder_boundary()
    {
        var tool = Tool(new StubProcessRunner());
        _settings.With<AgentSettings>(agent => agent.CommandTimeoutSeconds = 90);
        var script = "Write-Output '" + new string('x', 500) + "'\nWrite-Output 'last line'";
        var preview = await tool.DescribeAsync(Parse("powershell", script, "folder with spaces", 4), Token);
        Assert.Contains(script, preview.Preview!, StringComparison.Ordinal);
        Assert.Contains("folder with spaces", preview.Preview!, StringComparison.Ordinal);
        Assert.Contains("4s", preview.Preview!, StringComparison.Ordinal);
        Assert.Contains("not an OS sandbox", preview.Preview!, StringComparison.Ordinal);
        Assert.Equal(AgentToolRisk.Execute, tool.Risk);
    }

    [Fact]
    public async Task Output_and_time_caps_come_from_the_users_live_settings()
    {
        var runner = new StubProcessRunner();
        var tool = Tool(runner);
        _settings.With<AgentSettings>(agent =>
        {
            agent.CommandTimeoutSeconds = 3;
            agent.MaxCommandOutputCharacters = 1234;
        });
        Assert.True((await Run(tool, "cmd", "echo hello", seconds: 999)).Success);
        Assert.Equal(TimeSpan.FromSeconds(3), runner.Last!.Timeout);
        Assert.Equal(1234, runner.Last.MaxOutputCharacters);
    }

    [Fact]
    public async Task Failed_and_timed_out_processes_are_reported_as_tool_feedback()
    {
        var tool = Tool(new StubProcessRunner(_ => new ProcessRunResult
        {
            Started = true, TimedOut = true, Truncated = true, Output = "tail", Duration = TimeSpan.FromSeconds(2),
        }));
        var result = await Run(tool, "cmd", "echo hello");
        Assert.True(result.Success);
        Assert.Contains("timed out", result.Content, StringComparison.Ordinal);
        Assert.Contains("tail", result.Content, StringComparison.Ordinal);
        Assert.Contains("dropped", result.Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_real_cmd_script_handles_quotes_redirection_multiple_commands_Unicode_and_exit_code()
    {
        var tool = Tool(RealRunner());
        const string script = "echo first & echo \"quoted words & literal\" & >\"result with spaces.txt\" echo Привет & type \"result with spaces.txt\" & exit /b 7";
        var result = await Run(tool, "cmd", script);
        Assert.True(result.Success, result.Content);
        Assert.Contains("exit code 7", result.Content, StringComparison.Ordinal);
        Assert.Contains("first", result.Content, StringComparison.Ordinal);
        Assert.Contains("\"quoted words & literal\"", result.Content, StringComparison.Ordinal);
        Assert.Contains("Привет", result.Content, StringComparison.Ordinal);
        Assert.Contains("Привет", await File.ReadAllTextAsync(Path.Combine(_root, "result with spaces.txt"), Token), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_real_PowerShell_script_preserves_Unicode_multiline_quotes_and_explicit_exit_code()
    {
        var result = await Run(Tool(RealRunner()), "powershell",
            "Write-Output 'Привет \"мир\" & ;'\nSet-Content -LiteralPath 'test file.txt' -Value 'создано' -Encoding UTF8\nexit 7");
        Assert.True(result.Success, result.Content);
        Assert.Contains("exit code 7", result.Content, StringComparison.Ordinal);
        Assert.Contains("Привет \"мир\" & ;", result.Content, StringComparison.Ordinal);
        Assert.Contains("создано", await File.ReadAllTextAsync(Path.Combine(_root, "test file.txt"), Token), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_workspace_executable_cannot_shadow_the_system_CMD()
    {
        await File.WriteAllTextAsync(Path.Combine(_root, "cmd.exe"), "This is not an executable.", Token);
        var result = await Run(Tool(RealRunner()), "cmd", "echo trusted-system-shell");
        Assert.True(result.Success, result.Content);
        Assert.Contains("Succeeded", result.Content, StringComparison.Ordinal);
        Assert.Contains("trusted-system-shell", result.Content, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("powershell")]
    [InlineData("cmd")]
    public async Task Both_shell_paths_remove_secret_environment_variables(string shell)
    {
        var variable = $"AQVENOR_SHELL_{Guid.CreateVersion7():n}_TOKEN";
        Environment.SetEnvironmentVariable(variable, "dummy-secret-for-test");
        try
        {
            var script = shell == "powershell"
                ? $"if ([Environment]::GetEnvironmentVariable('{variable}')) {{ throw 'Secret was inherited' }}; Write-Output 'clean-environment'"
                : $"if defined {variable} (echo Secret was inherited & exit /b 7) else (echo clean-environment)";
            var result = await Run(Tool(RealRunner()), shell, script);
            Assert.True(result.Success, result.Content);
            Assert.Contains("Succeeded", result.Content, StringComparison.Ordinal);
            Assert.Contains("clean-environment", result.Content, StringComparison.Ordinal);
            Assert.DoesNotContain("dummy-secret-for-test", result.Content, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(variable, null);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Timeout_and_cancellation_leave_neither_the_shell_nor_its_child_alive(bool cancel)
    {
        const string script = "$child = Start-Process -WindowStyle Hidden -PassThru "
            + "-FilePath (Join-Path ([Environment]::GetFolderPath('System')) 'ping.exe') "
            + "-ArgumentList @('-n','20','127.0.0.1'); "
            + "$child.Id | Set-Content -LiteralPath 'child.pid'; $PID | Set-Content -LiteralPath 'parent.pid'; "
            + "Start-Sleep -Seconds 20";
        var clock = new ManualTimeProvider();
        var tool = Tool(RealRunner(clock));
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(Token);
        var execution = tool.ExecuteAsync(Parse("powershell", script, seconds: 2), stopping.Token);
        try
        {
            // OS startup is not what this test times. Both real processes must be ready before
            // Stop or the two-second execution deadline is triggered.
            await WaitForShellReadyAsync(execution);
            if (cancel)
            {
                stopping.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => execution);
            }
            else
            {
                clock.Advance(TimeSpan.FromSeconds(2));
                var result = await execution;
                Assert.Contains("timed out", result.Content, StringComparison.Ordinal);
            }
        }
        finally
        {
            stopping.Cancel();
            try { await execution; }
            catch (OperationCanceledException) { }
        }

        foreach (var file in new[] { "parent.pid", "child.pid" })
        {
            var path = Path.Combine(_root, file);
            Assert.True(File.Exists(path), $"The process did not record {file} before stopping.");
            var pid = int.Parse((await File.ReadAllTextAsync(path, Token)).Trim());
            Assert.False(IsAlive(pid), $"Process {pid} from {file} survived the stopped shell.");
        }
    }

    [Theory]
    [InlineData("powershell", "Start-Sleep -Seconds 20")]
    [InlineData("cmd", "ping -n 20 127.0.0.1 >nul")]
    public async Task A_real_shell_times_out_and_its_process_tree_is_stopped(string shell, string script)
    {
        var clock = Stopwatch.StartNew();
        var result = await Run(Tool(RealRunner()), shell, script, seconds: 1);
        Assert.True(result.Success, result.Content);
        Assert.Contains("timed out", result.Content, StringComparison.Ordinal);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10), $"took {clock.Elapsed}");
    }

    [Theory]
    [InlineData("powershell", "Start-Sleep -Seconds 20")]
    [InlineData("cmd", "ping -n 20 127.0.0.1 >nul")]
    public async Task Cancelling_a_real_shell_stops_it_and_propagates_cancellation(string shell, string script)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(Token);
        stopping.CancelAfter(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Tool(RealRunner()).ExecuteAsync(Parse(shell, script), stopping.Token));
    }

    [Fact]
    public async Task The_runner_refuses_ambiguous_raw_and_structured_arguments_before_start()
    {
        var result = await RealRunner().RunAsync(new ProcessRunRequest
        {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
            WorkingDirectory = _root, Arguments = ["/c", "echo unexpected"], WindowsCommandLine = "/c echo unexpected",
        }, Token);
        Assert.False(result.Started);
        Assert.Contains("arguments", result.Error!, StringComparison.OrdinalIgnoreCase);
    }

    private RunShellTool Tool(IProcessRunner runner, bool commands = true, bool shells = true)
    {
        _settings.With<AgentSettings>(agent =>
        {
            agent.AllowCommands = commands;
            agent.AllowShellCommands = shells;
            agent.AllowedCommands = [];
        });
        return new RunShellTool(_workspace, _settings, runner);
    }

    private static ProcessRunner RealRunner(TimeProvider? clock = null) => new(new RecordingLogger<ProcessRunner>(), clock);

    private async Task WaitForShellReadyAsync(Task execution)
    {
        var startup = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                var ready = true;
                foreach (var file in new[] { "parent.pid", "child.pid" })
                {
                    var path = Path.Combine(_root, file);
                    if (!File.Exists(path) || !int.TryParse((await File.ReadAllTextAsync(path, Token)).Trim(), out var pid) || !IsAlive(pid))
                    {
                        ready = false;
                        break;
                    }
                }
                if (ready) { return; }
            }
            catch (IOException)
            {
                // Set-Content can still have the marker open when the fixture first sees it.
            }

            Assert.False(execution.IsCompleted, "The shell stopped before both process markers were ready.");
            Assert.True(startup.Elapsed < TimeSpan.FromSeconds(10), "The shell fixture exceeded its separate ten-second startup deadline.");
            await Task.Delay(20, Token);
        }
    }

    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static AgentToolArguments Parse(string shell, string script, string? folder = null, int? seconds = null)
    {
        var values = new Dictionary<string, object?> { ["shell"] = shell, ["script"] = script };
        if (folder is not null)
        {
            values["working_directory"] = folder;
        }

        if (seconds is not null)
        {
            values["timeout_seconds"] = seconds;
        }
        Assert.True(AgentToolArguments.TryParse(JsonSerializer.Serialize(values), out var parsed, out var error), error);
        return parsed;
    }

    private static Task<AgentToolResult> Run(RunShellTool tool, string shell, string script, string? folder = null, int? seconds = null) =>
        tool.ExecuteAsync(Parse(shell, script, folder, seconds), Token);
}

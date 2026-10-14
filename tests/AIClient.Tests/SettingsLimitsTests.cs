using AIClient.Application.Configuration;

namespace AIClient.Tests;

/// <summary>
/// Every writer - the WPF screen, the HTTP surface, a hand-edited row - gets the
/// same bounds, because clamping lives in the settings layer rather than in a view.
/// </summary>
public sealed class SettingsLimitsTests
{
    [Theory]
    [InlineData(5, 2)]
    [InlineData(-1, 0)]
    [InlineData(0.7, 0.7)]
    public void Temperature_is_clamped_but_never_invented(double input, double expected)
    {
        var chat = new ChatSettings { Temperature = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.Temperature);
    }

    [Fact]
    public void A_missing_temperature_stays_missing()
    {
        // Null means "do not send this field". Clamping 0..2 must not turn it into 0.
        var chat = new ChatSettings { Temperature = null };

        SettingsLimits.Clamp(chat);

        Assert.Null(chat.Temperature);
    }

    [Theory]
    [InlineData(2, 1)]
    [InlineData(-0.5, 0)]
    public void TopP_is_clamped_but_never_invented(double input, double expected)
    {
        var chat = new ChatSettings { TopP = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.TopP);
    }

    [Fact]
    public void A_missing_topP_stays_missing()
    {
        var chat = new ChatSettings { TopP = null };

        SettingsLimits.Clamp(chat);

        Assert.Null(chat.TopP);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(9_999_999, 200_000)]
    public void MaxTokens_is_clamped_but_never_invented(int input, int expected)
    {
        var chat = new ChatSettings { MaxTokens = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.MaxTokens);
    }

    [Fact]
    public void A_missing_maxTokens_stays_missing()
    {
        var chat = new ChatSettings { MaxTokens = null };

        SettingsLimits.Clamp(chat);

        Assert.Null(chat.MaxTokens);
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(5000, 1000)]
    [InlineData(100, 100)]
    public void History_cap_stays_usable(int input, int expected)
    {
        var chat = new ChatSettings { MaxHistoryMessages = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.MaxHistoryMessages);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(500, 100)]
    [InlineData(85, 85)]
    public void Compaction_threshold_stays_a_percentage(int input, int expected)
    {
        var chat = new ChatSettings { CompactAtPercent = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.CompactAtPercent);
    }

    [Theory]
    [InlineData(-3, 0)]
    [InlineData(500, 100)]
    public void Compact_keep_recent_stays_in_range(int input, int expected)
    {
        var chat = new ChatSettings { CompactKeepRecentMessages = input };

        SettingsLimits.Clamp(chat);

        Assert.Equal(expected, chat.CompactKeepRecentMessages);
    }

    [Theory]
    [InlineData(-5, 1)]
    [InlineData(0, 1)]
    [InlineData(500, 100)]
    [InlineData(25, 25)]
    public void Step_budget_cannot_be_zeroed_or_blown_up(int input, int expected)
    {
        var agent = new AgentSettings { MaxSteps = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.MaxSteps);
    }

    [Theory]
    [InlineData(-5, 0)]
    [InlineData(0, 0)]
    [InlineData(99999, 7200)]
    public void Zero_duration_stays_unlimited(int input, int expected)
    {
        // Zero or less means "no ceiling" - clamping must not turn that into a ceiling.
        var agent = new AgentSettings { MaxDurationSeconds = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.MaxDurationSeconds);
    }

    [Theory]
    [InlineData(0, 1024)]
    [InlineData(10L * 1024 * 1024 * 1024, 100L * 1024 * 1024)]
    public void File_cap_cannot_be_zeroed_or_blown_up(long input, long expected)
    {
        var agent = new AgentSettings { MaxFileBytes = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.MaxFileBytes);
    }

    [Theory]
    [InlineData(0, 1000)]
    [InlineData(int.MaxValue, 10_000_000)]
    public void Read_cap_stays_usable(int input, int expected)
    {
        var agent = new AgentSettings { MaxReadCharacters = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.MaxReadCharacters);
    }

    [Theory]
    [InlineData(0, 5)]
    [InlineData(99999, 3600)]
    [InlineData(120, 120)]
    public void Command_timeout_cannot_be_zeroed(int input, int expected)
    {
        var agent = new AgentSettings { CommandTimeoutSeconds = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.CommandTimeoutSeconds);
    }

    [Theory]
    [InlineData(0, 1000)]
    [InlineData(int.MaxValue, 1_000_000)]
    public void Command_output_cap_stays_usable(int input, int expected)
    {
        var agent = new AgentSettings { MaxCommandOutputCharacters = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.MaxCommandOutputCharacters);
    }

    [Theory]
    [InlineData(0, 5)]
    [InlineData(999, 300)]
    public void Fetch_timeout_cannot_be_zeroed(int input, int expected)
    {
        var agent = new AgentSettings { FetchTimeoutSeconds = input };

        SettingsLimits.Clamp(agent);

        Assert.Equal(expected, agent.FetchTimeoutSeconds);
    }

    [Fact]
    public void Command_names_are_trimmed_and_empties_dropped()
    {
        var agent = new AgentSettings { AllowedCommands = [" dotnet ", "", "git", "  "] };

        SettingsLimits.Clamp(agent);

        Assert.Equal(["dotnet", "git"], agent.AllowedCommands);
    }

    [Fact]
    public void Ignored_names_are_trimmed_and_empties_dropped()
    {
        var agent = new AgentSettings { IgnoredNames = ["", "  node_modules  "] };

        SettingsLimits.Clamp(agent);

        Assert.Equal(["node_modules"], agent.IgnoredNames);
    }

    [Theory]
    [InlineData(0, 1024)]
    [InlineData(10L * 1024 * 1024 * 1024, 100L * 1024 * 1024)]
    public void Attachment_cap_cannot_be_zeroed(long input, long expected)
    {
        var storage = new StorageSettings { MaxAttachmentBytes = input };

        SettingsLimits.Clamp(storage);

        Assert.Equal(expected, storage.MaxAttachmentBytes);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(9999, 365)]
    [InlineData(7, 7)]
    public void Log_retention_stays_in_days(int input, int expected)
    {
        var storage = new StorageSettings { LogRetentionDays = input };

        SettingsLimits.Clamp(storage);

        Assert.Equal(expected, storage.LogRetentionDays);
    }

    [Theory]
    [InlineData("Verbose", "Information")]
    [InlineData("debug", "debug")]
    [InlineData("Information", "Information")]
    public void An_unknown_log_level_falls_back_without_touching_a_known_one(string input, string expected)
    {
        var storage = new StorageSettings { MinimumLogLevel = input };

        SettingsLimits.Clamp(storage);

        Assert.Equal(expected, storage.MinimumLogLevel);
    }

    [Theory]
    [InlineData(5, 10)]
    [InlineData(99, 24)]
    [InlineData(double.NaN, 14)]
    public void Font_sizes_stay_readable(double input, double expected)
    {
        var appearance = new AppearanceSettings { ChatFontSize = input };

        SettingsLimits.Clamp(appearance);

        Assert.Equal(expected, appearance.ChatFontSize);
    }

    [Theory]
    [InlineData("red", null)]
    [InlineData("#ZZZZZZ", null)]
    [InlineData("#38C9A5", "#38C9A5")]
    public void A_bad_accent_is_dropped_not_guessed(string? input, string? expected)
    {
        var appearance = new AppearanceSettings { AccentColor = input };

        SettingsLimits.Clamp(appearance);

        Assert.Equal(expected, appearance.AccentColor);
    }

    [Fact]
    public void Unknown_theme_and_language_fall_back_to_the_defaults()
    {
        var settings = new AppSettings
        {
            Appearance = new AppearanceSettings { Theme = (ThemeMode)99 },
            General = new GeneralSettings { Language = (UiLanguage)99 },
        };

        SettingsLimits.Clamp(settings);

        Assert.Equal(ThemeMode.System, settings.Appearance.Theme);
        Assert.Equal(UiLanguage.English, settings.General.Language);
    }

    [Theory]
    [InlineData(0, 100)]
    [InlineData(99999, 10000)]
    public void Visible_nodes_stay_renderable(int input, int expected)
    {
        var canvas = new CanvasSettings { MaxVisibleNodes = input };

        SettingsLimits.Clamp(canvas);

        Assert.Equal(expected, canvas.MaxVisibleNodes);
    }

    [Theory]
    [InlineData(0, 100)]
    [InlineData(9999999, 200000)]
    public void Indexed_nodes_stay_bounded(int input, int expected)
    {
        var canvas = new CanvasSettings { MaxIndexedNodes = input };

        SettingsLimits.Clamp(canvas);

        Assert.Equal(expected, canvas.MaxIndexedNodes);
    }

    [Theory]
    [InlineData(0, 0.05)]
    [InlineData(5, 1.0)]
    [InlineData(double.NaN, 0.4)]
    [InlineData(0.4, 0.4)]
    public void Context_share_stays_a_share(double input, double expected)
    {
        var canvas = new CanvasSettings { MaxContextShare = input };

        SettingsLimits.Clamp(canvas);

        Assert.Equal(expected, canvas.MaxContextShare);
    }

    [Theory]
    [InlineData(-1, 0)]
    [InlineData(99, 5)]
    public void Context_depth_stays_in_range(int input, int expected)
    {
        var canvas = new CanvasSettings { ContextDepth = input };

        SettingsLimits.Clamp(canvas);

        Assert.Equal(expected, canvas.ContextDepth);
    }
}

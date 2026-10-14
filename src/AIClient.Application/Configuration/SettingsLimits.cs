using System.Text.RegularExpressions;

namespace AIClient.Application.Configuration;

/// <summary>
/// Central bounds for every tunable value, applied wherever settings are saved.
/// </summary>
/// <remarks>
/// <para>
/// The WPF settings screen used to be the only writer and clamped in its own change
/// handlers; the HTTP settings surface writes through the same service with no UI
/// in front of it. Bounds that live in one host are bounds the other host does not
/// have, so a PUT of <c>{"maxSteps": 1000000}</c> used to stick. Clamping here -
/// inside <c>UpdateAsync</c> and after <c>LoadAsync</c> - means every writer gets
/// the same values and no reader has to defend itself.
/// </para>
/// <para>
/// Ranges mirror the WPF screen's clamps where one exists, so the two hosts agree
/// about what a value means. A clamp never throws and never widens: garbage becomes
/// the nearest sane value, and a missing (null) sampling parameter stays missing -
/// null means "do not send this field", which clamping must not reinterpret.
/// </para>
/// </remarks>
public static partial class SettingsLimits
{
    /// <summary>Clamps every section of the tree in place.</summary>
    public static void Clamp(AppSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        Clamp(settings.General);
        Clamp(settings.Appearance);
        Clamp(settings.Chat);
        Clamp(settings.Storage);
        Clamp(settings.Agent);
        Clamp(settings.Canvas);
    }

    public static void Clamp(GeneralSettings general)
    {
        ArgumentNullException.ThrowIfNull(general);

        if (!Enum.IsDefined(general.Language))
        {
            general.Language = UiLanguage.English;
        }
    }

    public static void Clamp(AppearanceSettings appearance)
    {
        ArgumentNullException.ThrowIfNull(appearance);

        if (!Enum.IsDefined(appearance.Theme))
        {
            appearance.Theme = ThemeMode.System;
        }

        appearance.ChatFontSize = ClampDouble(appearance.ChatFontSize, 10, 24, 14);
        appearance.CodeFontSize = ClampDouble(appearance.CodeFontSize, 9, 22, 13);

        // 0 disables the cap; anything else is a width in pixels.
        if (appearance.MaxChatContentWidth < 0 || appearance.MaxChatContentWidth > 5000)
        {
            appearance.MaxChatContentWidth = appearance.MaxChatContentWidth < 0 ? 0 : 5000;
        }

        if (appearance.AccentColor is not null && !AccentColorPattern().IsMatch(appearance.AccentColor))
        {
            appearance.AccentColor = null;
        }
    }

    public static void Clamp(ChatSettings chat)
    {
        ArgumentNullException.ThrowIfNull(chat);

        if (chat.Temperature is { } temperature)
        {
            chat.Temperature = Math.Clamp(temperature, 0, 2);
        }

        if (chat.TopP is { } topP)
        {
            chat.TopP = Math.Clamp(topP, 0, 1);
        }

        if (chat.MaxTokens is { } maxTokens)
        {
            chat.MaxTokens = Math.Clamp(maxTokens, 1, 200_000);
        }

        chat.MaxHistoryMessages = Math.Clamp(chat.MaxHistoryMessages, 2, 1000);
        chat.RequestTimeoutSeconds = Math.Clamp(chat.RequestTimeoutSeconds, 10, 3600);
        chat.ReservedOutputTokens = Math.Clamp(chat.ReservedOutputTokens, 0, 32_000);
        chat.CompactAtPercent = Math.Clamp(chat.CompactAtPercent, 10, 100);
        chat.CompactKeepRecentMessages = Math.Clamp(chat.CompactKeepRecentMessages, 0, 100);
    }

    /// <summary>Log level names the file sink understands; anything else is not a level.</summary>
    private static readonly HashSet<string> LogLevels = new(StringComparer.OrdinalIgnoreCase)
    {
        "Trace", "Debug", "Information", "Warning", "Error", "Critical", "None",
    };

    public static void Clamp(StorageSettings storage)
    {
        ArgumentNullException.ThrowIfNull(storage);

        storage.MaxAttachmentBytes = Math.Clamp(storage.MaxAttachmentBytes, 1024, 100L * 1024 * 1024);
        storage.MaxAttachmentCharacters = Math.Clamp(storage.MaxAttachmentCharacters, 1000, 10_000_000);
        storage.LogRetentionDays = Math.Clamp(storage.LogRetentionDays, 1, 365);

        if (!LogLevels.Contains(storage.MinimumLogLevel))
        {
            storage.MinimumLogLevel = "Information";
        }
    }

    public static void Clamp(AgentSettings agent)
    {
        ArgumentNullException.ThrowIfNull(agent);

        agent.MaxSteps = Math.Clamp(agent.MaxSteps, 1, 100);
        agent.MaxDurationSeconds = Math.Clamp(agent.MaxDurationSeconds, 0, 7200);
        agent.MaxFileBytes = Math.Clamp(agent.MaxFileBytes, 1024, 100L * 1024 * 1024);
        agent.MaxReadCharacters = Math.Clamp(agent.MaxReadCharacters, 1000, 10_000_000);
        agent.MaxListEntries = Math.Clamp(agent.MaxListEntries, 1, 10_000);
        agent.MaxSearchResults = Math.Clamp(agent.MaxSearchResults, 1, 5000);
        agent.MaxIdenticalCalls = Math.Clamp(agent.MaxIdenticalCalls, 0, 1000);
        agent.CommandTimeoutSeconds = Math.Clamp(agent.CommandTimeoutSeconds, 5, 3600);
        agent.MaxCommandOutputCharacters = Math.Clamp(agent.MaxCommandOutputCharacters, 1000, 1_000_000);
        agent.FetchTimeoutSeconds = Math.Clamp(agent.FetchTimeoutSeconds, 5, 300);
        agent.MaxFetchResponseCharacters = Math.Clamp(agent.MaxFetchResponseCharacters, 1000, 1_000_000);

        agent.AllowedCommands = CleanNames(agent.AllowedCommands);
        agent.IgnoredNames = CleanNames(agent.IgnoredNames);
    }

    public static void Clamp(CanvasSettings canvas)
    {
        ArgumentNullException.ThrowIfNull(canvas);

        canvas.MaxVisibleNodes = Math.Clamp(canvas.MaxVisibleNodes, 100, 10_000);
        canvas.MaxIndexedNodes = Math.Clamp(canvas.MaxIndexedNodes, 100, 200_000);
        canvas.MaxContextShare = ClampDouble(canvas.MaxContextShare, 0.05, 1.0, 0.4);
        canvas.ContextDepth = Math.Clamp(canvas.ContextDepth, 0, 5);
    }

    /// <summary>Trims entries and drops empties (and caps a runaway list).</summary>
    private static List<string> CleanNames(List<string> names)
    {
        ArgumentNullException.ThrowIfNull(names);

        return names
            .Select(name => name.Trim())
            .Where(name => name.Length > 0)
            .Take(1000)
            .ToList();
    }

    private static double ClampDouble(double value, double min, double max, double fallback)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return fallback;
        }

        return Math.Clamp(value, min, max);
    }

    [GeneratedRegex("^#[0-9A-Fa-f]{6}$")]
    private static partial Regex AccentColorPattern();
}

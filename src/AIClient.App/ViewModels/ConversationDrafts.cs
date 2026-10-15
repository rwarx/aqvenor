using AIClient.Application.DTOs;

namespace AIClient.App.ViewModels;

/// <summary>
/// Unsent composer state per conversation: the draft text plus the staged
/// file tray. One pane shows one chat at a time, so without this the words
/// typed in chat A are either wiped or leak into chat B on every switch.
/// </summary>
/// <remarks>
/// Attachments are immutable records, so stashing shares the instances
/// rather than copying file contents. Key unsaved chats with
/// <see cref="Guid.Empty"/> — there is only ever one of them per pane.
/// </remarks>
public sealed class ConversationDrafts
{
    private readonly Dictionary<Guid, (string Text, List<NewAttachment> Attachments)> _drafts = new();

    /// <summary>Stashes the pane's current input under the given conversation key.</summary>
    public void Save(Guid key, string text, IReadOnlyList<NewAttachment> attachments)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(attachments);
        _drafts[key] = (text, [.. attachments]);
    }

    /// <summary>
    /// Returns the stashed input, or an empty draft when this conversation has
    /// nothing stashed. Never returns nulls — the composer binds directly.
    /// </summary>
    public (string Text, List<NewAttachment> Attachments) Restore(Guid key) =>
        _drafts.TryGetValue(key, out var draft)
            ? (draft.Text, [.. draft.Attachments])
            : (string.Empty, []);

    /// <summary>Drops everything stashed for a deleted conversation.</summary>
    /// <returns>True when anything was stashed.</returns>
    public bool Forget(Guid key) => _drafts.Remove(key);
}

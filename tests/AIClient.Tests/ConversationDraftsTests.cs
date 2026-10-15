using AIClient.App.ViewModels;
using AIClient.Application.DTOs;

namespace AIClient.Tests;

/// <summary>
/// Unsent composer state stashed per conversation, so switching chats neither
/// wipes the words nor pours one chat's draft into another.
/// </summary>
public sealed class ConversationDraftsTests
{
    private static NewAttachment File(string name) =>
        new() { FileName = name, MimeType = "text/plain", Size = 3, TextContent = name };

    [Fact]
    public void A_chat_with_nothing_stashed_restores_an_empty_draft()
    {
        var drafts = new ConversationDrafts();

        var (text, attachments) = drafts.Restore(Guid.CreateVersion7());

        Assert.Equal(string.Empty, text);
        Assert.Empty(attachments);
    }

    [Fact]
    public void Two_chats_keep_independent_drafts_and_trays()
    {
        var drafts = new ConversationDrafts();
        var first = Guid.CreateVersion7();
        var second = Guid.CreateVersion7();

        drafts.Save(first, "hello", [File("a.txt")]);
        drafts.Save(second, "world", [File("b.txt"), File("c.txt")]);

        Assert.Equal("hello", drafts.Restore(first).Text);
        Assert.Equal(["a.txt"], drafts.Restore(first).Attachments.Select(a => a.FileName));
        Assert.Equal("world", drafts.Restore(second).Text);
        Assert.Equal(["b.txt", "c.txt"], drafts.Restore(second).Attachments.Select(a => a.FileName));
    }

    [Fact]
    public void Saving_again_replaces_the_whole_stash()
    {
        var drafts = new ConversationDrafts();
        var id = Guid.CreateVersion7();

        drafts.Save(id, "first", [File("a.txt")]);
        drafts.Save(id, "second", []);

        var (text, attachments) = drafts.Restore(id);

        Assert.Equal("second", text);
        Assert.Empty(attachments);
    }

    [Fact]
    public void Forgetting_drops_only_that_conversation()
    {
        var drafts = new ConversationDrafts();
        var doomed = Guid.CreateVersion7();
        var kept = Guid.CreateVersion7();

        drafts.Save(doomed, "gone", []);
        drafts.Save(kept, "stays", []);

        Assert.True(drafts.Forget(doomed));
        Assert.False(drafts.Forget(doomed));

        Assert.Equal(string.Empty, drafts.Restore(doomed).Text);
        Assert.Equal("stays", drafts.Restore(kept).Text);
    }
}

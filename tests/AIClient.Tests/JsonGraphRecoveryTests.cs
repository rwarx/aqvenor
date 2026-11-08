using System.Text;
using AIClient.Application.Graph;
using AIClient.Domain.Graph;
using AIClient.Infrastructure.Configuration;
using AIClient.Infrastructure.Graph;
using AIClient.Infrastructure.Workspace;
using AIClient.Server;
using AIClient.Tests.Support;
using Microsoft.Extensions.Logging.Abstractions;

namespace AIClient.Tests;

public sealed class JsonGraphRecoveryTests : IAsyncLifetime
{
    private readonly string _scratch = Path.Combine(Path.GetTempPath(), "aqvenor-graph-recovery", Guid.NewGuid().ToString("N"));
    private CancellationToken Token => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync()
    {
        Directory.CreateDirectory(_scratch);
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        var expectedParent = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "aqvenor-graph-recovery"));
        if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(_scratch)), expectedParent, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Recovery test cleanup escaped its scratch directory.");
        }
        Directory.Delete(_scratch, recursive: true);
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task Close_save_preserves_the_original_corrupt_bytes_before_replacing_the_private_graph()
    {
        var root = Path.Combine(_scratch, "project");
        Directory.CreateDirectory(root);
        var paths = new AppPaths(Path.Combine(_scratch, "data"));
        var workspace = new WorkspaceService(new StubSettingsService(), paths, NullLogger<WorkspaceService>.Instance);
        Assert.True((await workspace.OpenAsync(root, Token)).Success);
        var store = new JsonGraphStore(paths, NullLogger<JsonGraphStore>.Instance);
        var key = GraphPersistence.KeyForRoot(root);
        await store.SaveAsync(key, GraphSnapshot.Empty, Token);
        var directory = Path.Combine(paths.DataDirectory, "graphs");
        var source = Directory.GetFiles(directory, "*.json").Single();
        byte[] original = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("{\"nodes\":[{\"id\":\"repairable\"}\r\n"), 0xff];
        await File.WriteAllBytesAsync(source, original, Token);
        var existingBackup = Path.Combine(directory, "existing.corrupt-preserved.json");
        await File.WriteAllTextAsync(existingBackup, "earlier recovery copy", Token);

        using var persistence = new GraphPersistence(new GraphService(store), workspace,
            NullLogger<GraphPersistence>.Instance, store, paths);
        await persistence.InitializeAsync(Token);
        Assert.False(persistence.Status.PrivateSaved);
        Assert.NotNull(persistence.Status.Error);
        Assert.True((await persistence.SaveCurrentAsync(Token)).PrivateSaved);

        var backup = Assert.Single(Directory.GetFiles(directory, "*.corrupt-*.json"), file => file != existingBackup);
        Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token));
        Assert.Equal("earlier recovery copy", await File.ReadAllTextAsync(existingBackup, Token));
        Assert.NotNull(await store.LoadAsync(key, Token));
        await persistence.SaveCurrentAsync(Token);
        Assert.Equal(2, Directory.GetFiles(directory, "*.corrupt-*.json").Length);
    }

    [Fact]
    public async Task A_backup_read_failure_preserves_the_original_and_allows_retry()
    {
        var paths = new AppPaths(Path.Combine(_scratch, "data"));
        var store = new JsonGraphStore(paths, NullLogger<JsonGraphStore>.Instance);
        const string key = "corrupt-recovery";
        await store.SaveAsync(key, GraphSnapshot.Empty, Token);
        var source = Directory.GetFiles(Path.Combine(paths.DataDirectory, "graphs"), "*.json").Single();
        var original = Encoding.UTF8.GetBytes("{repairable, invalid JSON");
        await File.WriteAllBytesAsync(source, original, Token);
        Assert.Null(await store.LoadAsync(key, Token));

        // Deny the source reads needed to preserve the damaged document.
        using (var blockedRead = new FileStream(source, FileMode.Open, FileAccess.ReadWrite, FileShare.Write | FileShare.Delete))
        {
            await Assert.ThrowsAnyAsync<IOException>(() => store.SaveAsync(key, GraphSnapshot.Empty, Token));
        }
        Assert.Equal(original, await File.ReadAllBytesAsync(source, Token));
        await store.SaveAsync(key, GraphSnapshot.Empty, Token);
        var backup = Assert.Single(Directory.GetFiles(Path.Combine(paths.DataDirectory, "graphs"), "*.corrupt-*.json"));
        Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{\"nodes\":null,\"edges\":[]}")]
    [InlineData("{\"nodes\":[null],\"edges\":[]}")]
    [InlineData("{\"nodes\":[],\"edges\":[null]}")]
    public async Task Invalid_document_content_is_preserved_when_an_alias_key_saves(string content)
    {
        var paths = new AppPaths(Path.Combine(_scratch, "data"));
        var store = new JsonGraphStore(paths, NullLogger<JsonGraphStore>.Instance);
        await store.SaveAsync("document", GraphSnapshot.Empty, Token);
        var directory = Path.Combine(paths.DataDirectory, "graphs");
        var source = Directory.GetFiles(directory, "*.json").Single();
        var original = Encoding.UTF8.GetBytes(content);
        await File.WriteAllBytesAsync(source, original, Token);

        Assert.Null(await store.LoadAsync("Document", Token));
        Assert.NotNull(store.LastLoadError);
        await store.SaveAsync("document", GraphSnapshot.Empty, Token);
        var backup = Assert.Single(Directory.GetFiles(directory, "*.corrupt-*.json"));
        Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token));
    }

    [Fact]
    public async Task Close_save_preserves_the_original_corrupt_layout_before_replacing_it()
    {
        var (store, workspace, paths, layoutPath) = await CreateCorruptLayoutAsync();
        var original = await File.ReadAllBytesAsync(layoutPath, Token);
        var existingBackup = Path.ChangeExtension(layoutPath, "corrupt-existing.json");
        await File.WriteAllTextAsync(existingBackup, "earlier viewport recovery", Token);
        using var persistence = new GraphPersistence(new GraphService(store), workspace,
            NullLogger<GraphPersistence>.Instance, store, paths);
        await persistence.InitializeAsync(Token);
        Assert.False(persistence.Status.PrivateSaved);
        Assert.NotNull(persistence.Status.Error);

        Assert.True((await persistence.SaveCurrentAsync(Token)).PrivateSaved);
        var backups = Directory.GetFiles(Path.GetDirectoryName(layoutPath)!, "*.layout.corrupt-*.json");
        var backup = Assert.Single(backups, file => file != existingBackup);
        Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token));
        Assert.Equal("earlier viewport recovery", await File.ReadAllTextAsync(existingBackup, Token));
        await persistence.SaveCurrentAsync(Token);
        Assert.Equal(2, Directory.GetFiles(Path.GetDirectoryName(layoutPath)!, "*.layout.corrupt-*.json").Length);
    }

    [Fact]
    public async Task A_layout_backup_read_failure_preserves_the_original_and_allows_retry()
    {
        var (store, workspace, paths, layoutPath) = await CreateCorruptLayoutAsync();
        var original = await File.ReadAllBytesAsync(layoutPath, Token);
        using var persistence = new GraphPersistence(new GraphService(store), workspace,
            NullLogger<GraphPersistence>.Instance, store, paths);
        await persistence.InitializeAsync(Token);
        using (var blockedRead = new FileStream(layoutPath, FileMode.Open, FileAccess.ReadWrite, FileShare.Write | FileShare.Delete))
        {
            var status = await persistence.SaveCurrentAsync(Token);
            Assert.False(status.PrivateSaved);
            Assert.NotNull(status.Error);
            Assert.False(File.Exists(layoutPath + ".tmp"));
        }
        Assert.Equal(original, await File.ReadAllBytesAsync(layoutPath, Token));
        Assert.True((await persistence.SaveCurrentAsync(Token)).PrivateSaved);
        var backup = Assert.Single(Directory.GetFiles(Path.GetDirectoryName(layoutPath)!, "*.layout.corrupt-*.json"));
        Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token));
    }

    private async Task<(JsonGraphStore Store, WorkspaceService Workspace, AppPaths Paths, string LayoutPath)> CreateCorruptLayoutAsync()
    {
        var root = Path.Combine(_scratch, "project");
        Directory.CreateDirectory(root);
        var paths = new AppPaths(Path.Combine(_scratch, "data"));
        var workspace = new WorkspaceService(new StubSettingsService(), paths, NullLogger<WorkspaceService>.Instance);
        Assert.True((await workspace.OpenAsync(root, Token)).Success);
        var store = new JsonGraphStore(paths, NullLogger<JsonGraphStore>.Instance);
        await store.SaveAsync(GraphPersistence.KeyForRoot(root), GraphSnapshot.Empty, Token);
        var source = Directory.GetFiles(Path.Combine(paths.DataDirectory, "graphs"), "*.json").Single();
        var layoutPath = Path.ChangeExtension(source, "layout.json");
        byte[] original = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("{\"viewport\":{\"zoom\":1},\"additionalData\":{\"user\":\"recover me\"}\r\n"), 0xff];
        await File.WriteAllBytesAsync(layoutPath, original, Token);
        return (store, workspace, paths, layoutPath);
    }
}

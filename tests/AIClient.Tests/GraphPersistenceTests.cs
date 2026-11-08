using System.Text.Json;
using System.Net;
using System.Net.Http.Json;
using AIClient.Application.Configuration;
using AIClient.Application.Graph;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;
using AIClient.Infrastructure.Configuration;
using AIClient.Infrastructure;
using AIClient.Infrastructure.Graph;
using AIClient.Infrastructure.Workspace;
using AIClient.Server;
using AIClient.Tests.Support;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

public sealed class GraphPersistenceTests : IAsyncLifetime
{
    private readonly string _scratch = Path.Combine(Path.GetTempPath(), "aqvenor-graph", Guid.NewGuid().ToString("N"));
    private string _root = null!;
    private AppPaths _paths = null!;
    private WorkspaceService _workspace = null!;
    private readonly List<GraphPersistence> _persistence = [];
    private CancellationToken Token => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _root = Path.Combine(_scratch, "project");
        Directory.CreateDirectory(_root);
        _paths = new AppPaths(Path.Combine(_scratch, "data"));
        _workspace = new WorkspaceService(new StubSettingsService(), _paths, NullLogger<WorkspaceService>.Instance);
        Assert.True((await _workspace.OpenAsync(_root, Token)).Success);
    }

    public ValueTask DisposeAsync()
    {
        foreach (var persist in _persistence) { persist.Dispose(); }
        if (File.Exists(CanvasFile)) { File.SetAttributes(CanvasFile, FileAttributes.Normal); }
        try { Directory.Delete(_scratch, true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return ValueTask.CompletedTask;
    }

    private string CanvasFile => Path.Combine(_root, ".aqvenor", "canvas.json");
    private JsonGraphStore DiskStore() => new(_paths, NullLogger<JsonGraphStore>.Instance);
    private GraphPersistence Persist(GraphService graph, IGraphStore store)
    {
        var persist = new GraphPersistence(graph, _workspace, NullLogger<GraphPersistence>.Instance, store, _paths);
        _persistence.Add(persist);
        return persist;
    }
    private async Task WriteCanvasAsync(string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CanvasFile)!);
        await File.WriteAllTextAsync(CanvasFile, content, Token);
    }
    private static GraphChangeSet Add(string id) => new()
    {
        Title = "Add " + id, Origin = GraphChangeOrigin.User,
        Changes = [new AddNode(new GraphNode { Id = id, Title = id, Kind = GraphNodeKind.Note })],
    };

    [Fact]
    public async Task A_legacy_canvas_is_imported_before_reindex_with_positions_annotations_and_viewport()
    {
        await WriteCanvasAsync("""
            {"version":1,"viewport":{"zoom":0.75,"panX":25,"panY":-30},"ui":{"showGrid":false},
             "nodes":[{"id":"a","kind":"note","title":"Annotation","meta":"subtitle","note":"detail","path":"src/a.cs","x":13,"y":24,"w":321,"h":123,"status":"done","color":"red"},
                      {"id":"b","kind":"module","title":"Module","x":100,"y":200}],
             "edges":[{"id":"e","from":"a","to":"b","kind":"depends","note":"connection"}]}
            """);
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        var node = Assert.Single(graph.Current.Nodes, n => n.Id == "a");
        Assert.Equal((13, 24, 321, 123), (node.X, node.Y, node.Width, node.Height));
        Assert.Equal("subtitle", node.Subtitle);
        Assert.Equal("detail", node.Detail);
        Assert.Equal("src/a.cs", node.Path);
        Assert.Equal(GraphNodeState.Done, node.Status);
        Assert.Equal("connection", Assert.Single(graph.Current.Edges).Label);
        Assert.Equal(new GraphViewport(0.75, 25, -30), persist.Viewport);
        Assert.False(persist.Status.PrivateSaved);
        Assert.Equal("saved", (await persist.SaveCurrentAsync(Token)).State);
        var saved = PortableGraphDocument.Parse(await File.ReadAllTextAsync(CanvasFile, Token));
        Assert.Equal(2, saved.Version);
        Assert.Equal(graph.Current, saved.Snapshot);
        Assert.False(saved.AdditionalData["ui"].GetProperty("showGrid").GetBoolean());
        Assert.Equal("red", saved.AdditionalData["legacyNodeMetadata"].GetProperty("a").GetProperty("color").GetString());
        Assert.False(JsonDocument.Parse(saved.Serialize()).RootElement.GetProperty("viewport").TryGetProperty("isValid", out _));
    }

    [Fact]
    public async Task A_saved_private_graph_wins_over_a_different_portable_snapshot()
    {
        var store = DiskStore();
        var original = new GraphService(store);
        await original.ApplyAsync(Add("authoritative"), Token);
        await original.SaveAsync(GraphPersistence.KeyForRoot(_root), Token);
        await WriteCanvasAsync(new PortableGraphDocument
        {
            Snapshot = new GraphSnapshot { Nodes = [new GraphNode { Id = "portable", Title = "portable" }] },
            Viewport = new(0.5, 10, 20),
        }.Serialize());
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        Assert.Equal("authoritative", Assert.Single(graph.Current.Nodes).Id);
        Assert.Equal(new GraphViewport(0.5, 10, 20), persist.Viewport);
    }

    [Fact]
    public async Task An_external_portable_edit_is_preserved_and_the_private_graph_is_durable()
    {
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await graph.ApplyAsync(Add("first"), Token);
        await persist.SaveCurrentAsync(Token);
        const string external = "{\"version\":2,\"external\":true}";
        await File.WriteAllTextAsync(CanvasFile, external, Token);
        await graph.ApplyAsync(Add("second"), Token);
        var status = await persist.SaveCurrentAsync(Token);
        Assert.Equal("error", status.State);
        Assert.True(status.PrivateSaved);
        Assert.NotNull(status.PortableError);
        Assert.Equal(external, await File.ReadAllTextAsync(CanvasFile, Token));
        Assert.Equal(graph.Current, await store.LoadAsync(GraphPersistence.KeyForRoot(_root), Token));
    }

    [Fact]
    public async Task A_canvas_created_after_initial_read_cannot_be_overwritten_by_the_first_save()
    {
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        const string external = "someone else created this canvas";
        await WriteCanvasAsync(external);
        await graph.ApplyAsync(Add("mine"), Token);
        Assert.NotNull((await persist.SaveCurrentAsync(Token)).PortableError);
        Assert.Equal(external, await File.ReadAllTextAsync(CanvasFile, Token));
    }

    [Fact]
    public async Task A_read_only_portable_canvas_does_not_lose_the_private_viewport_after_restart()
    {
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await graph.ApplyAsync(Add("node"), Token);
        await persist.SaveCurrentAsync(Token);
        File.SetAttributes(CanvasFile, FileAttributes.ReadOnly);
        var viewport = new GraphViewport(0.25, 123, -456);
        var status = await persist.SetViewportAsync(viewport, Token);
        Assert.True(status.PrivateSaved);
        Assert.Equal("error", status.State);
        Assert.NotNull(status.PortableError);
        persist.Dispose();
        var restartedGraph = new GraphService(store);
        var restarted = Persist(restartedGraph, store);
        await restarted.InitializeAsync(Token);
        Assert.Equal(viewport, restarted.Viewport);
        Assert.Equal("node", Assert.Single(restartedGraph.Current.Nodes).Id);
    }

    [Fact]
    public async Task A_failed_private_save_preserves_the_graph_and_a_save_retry_does_not_reapply_it()
    {
        var store = new TestStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        store.FailWrites = true;
        await graph.ApplyAsync(Add("unsaved"), Token);
        var failed = await persist.SaveCurrentAsync(Token);
        Assert.Equal("error", failed.State);
        Assert.False(failed.PrivateSaved);
        Assert.NotNull(failed.Error);
        Assert.Equal("unsaved", Assert.Single(graph.Current.Nodes).Id);
        store.FailWrites = false;
        Assert.Equal("saved", (await persist.SaveCurrentAsync(Token)).State);
        Assert.Single(graph.Timeline);
        Assert.Equal(graph.Current, await store.LoadAsync(GraphPersistence.KeyForRoot(_root), Token));
    }

    [Fact]
    public async Task Direct_workspace_switches_retain_a_graph_when_the_private_disk_is_unavailable()
    {
        var store = new TestStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await graph.ApplyAsync(Add("unsaved"), Token);
        store.FailWrites = true;
        var second = Path.Combine(_scratch, "second");
        Directory.CreateDirectory(second);
        Assert.True((await _workspace.OpenAsync(second, Token)).Success);
        await persist.WaitForReadyAsync(Token);
        Assert.Empty(graph.Current.Nodes);
        Assert.True((await _workspace.OpenAsync(_root, Token)).Success);
        await persist.WaitForReadyAsync(Token);
        Assert.Equal("unsaved", Assert.Single(graph.Current.Nodes).Id);
        Assert.False(persist.Status.PrivateSaved);
        store.FailWrites = false;
        Assert.Equal("saved", (await persist.SaveCurrentAsync(Token)).State);
    }

    [Fact]
    public async Task Undo_and_checkpoint_reload_are_pending_and_saved_to_both_copies()
    {
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await graph.ApplyAsync(Add("first"), Token);
        await graph.SaveAsync("checkpoint", Token);
        await graph.ApplyAsync(Add("second"), Token);
        await persist.SaveCurrentAsync(Token);
        var revision = persist.Revision;
        await graph.UndoAsync(Token);
        Assert.True(persist.Revision > revision);
        Assert.Equal("pending", persist.Status.State);
        await persist.SaveCurrentAsync(Token);
        Assert.Single(PortableGraphDocument.Parse(await File.ReadAllTextAsync(CanvasFile, Token)).Snapshot.Nodes);
        await graph.ApplyAsync(Add("third"), Token);
        await graph.LoadAsync("checkpoint", Token);
        Assert.Equal("pending", persist.Status.State);
        await persist.SaveCurrentAsync(Token);
        Assert.Equal("first", Assert.Single(PortableGraphDocument.Parse(await File.ReadAllTextAsync(CanvasFile, Token)).Snapshot.Nodes).Id);
    }

    [Fact]
    public async Task An_edit_during_a_disk_write_keeps_persistence_pending_until_its_own_flush()
    {
        var store = new TestStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await graph.ApplyAsync(Add("first"), Token);
        store.PauseWrites = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var save = persist.SaveCurrentAsync(Token);
        await store.WriteStarted.Task.WaitAsync(Token);
        await graph.ApplyAsync(Add("second"), Token);
        store.PauseWrites.SetResult();
        var status = await save;
        Assert.Equal("pending", status.State);
        Assert.False(status.PrivateSaved);
        store.PauseWrites = null;
        Assert.Equal("saved", (await persist.SaveCurrentAsync(Token)).State);
    }

    [Fact]
    public async Task Malformed_portable_json_is_reported_and_preserved_while_private_graph_still_saves()
    {
        const string malformed = "{broken";
        await WriteCanvasAsync(malformed);
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        Assert.Equal("error", persist.Status.State);
        await graph.ApplyAsync(Add("safe"), Token);
        var status = await persist.SaveCurrentAsync(Token);
        Assert.True(status.PrivateSaved);
        Assert.NotNull(status.PortableError);
        Assert.Equal(malformed, await File.ReadAllTextAsync(CanvasFile, Token));
    }

    [Theory]
    [InlineData("{\"version\":99,\"snapshot\":{\"nodes\":[],\"edges\":[]}}")]
    [InlineData("{\"version\":2,\"snapshot\":{\"nodes\":[{\"id\":\"a\",\"title\":\"A\",\"width\":0}],\"edges\":[]}}")]
    [InlineData("{\"version\":2,\"snapshot\":{\"nodes\":[],\"edges\":[{\"id\":\"e\",\"sourceId\":\"a\",\"targetId\":\"b\"}]}}")]
    [InlineData("{\"version\":2,\"snapshot\":{\"nodes\":[{\"id\":\"a\",\"title\":\"A\",\"kind\":\"unexpected\"}],\"edges\":[]}}")]
    public void Invalid_portable_documents_are_rejected_before_the_graph_is_loaded(string content) =>
        Assert.Throws<JsonException>(() => PortableGraphDocument.Parse(content));

    [Fact]
    public async Task Geometry_and_path_edits_survive_snapshot_save_and_invalid_geometry_is_refused()
    {
        var graph = new GraphService(DiskStore());
        await graph.ApplyAsync(Add("a"), Token);
        var resized = await graph.ApplyAsync(new GraphChangeSet
        {
            Title = "resize", Changes = [new UpdateNode("a", Width: 320, Height: 128, Path: "src/a.cs")],
        }, Token);
        Assert.Empty(resized.Rejected);
        Assert.Equal((320, 128, "src/a.cs"), (graph.Current.Nodes[0].Width, graph.Current.Nodes[0].Height, graph.Current.Nodes[0].Path));
        var rejected = await graph.ApplyAsync(new GraphChangeSet { Title = "bad resize", Changes = [new UpdateNode("a", Width: double.NaN)] }, Token);
        Assert.NotEmpty(rejected.Rejected);
        Assert.Equal(320, graph.Current.Nodes[0].Width);
    }

    [Fact]
    public async Task An_explicitly_saved_empty_graph_is_distinguished_from_a_pristine_workspace()
    {
        var store = DiskStore();
        var persist = Persist(new GraphService(store), store);
        await persist.InitializeAsync(Token);
        Assert.False(persist.HasSavedGraph);
        await persist.SaveCurrentAsync(Token);
        Assert.True(persist.HasSavedGraph);
        persist.Dispose();
        var restarted = Persist(new GraphService(store), store);
        await restarted.InitializeAsync(Token);
        Assert.True(restarted.HasSavedGraph);
    }

    [Fact]
    public async Task Corrupt_private_graph_loads_are_visible_and_do_not_look_like_pristine_workspaces()
    {
        var store = DiskStore();
        await store.SaveAsync(GraphPersistence.KeyForRoot(_root), GraphSnapshot.Empty, Token);
        var privateGraph = Directory.GetFiles(Path.Combine(_paths.DataDirectory, "graphs"), "*.json").Single();
        await File.WriteAllTextAsync(privateGraph, "{broken", Token);
        var persist = Persist(new GraphService(store), store);
        await persist.InitializeAsync(Token);
        Assert.True(persist.HasSavedGraph);
        Assert.NotNull(persist.Status.Error);
        Assert.False(persist.Status.PrivateSaved);
    }

    [Fact]
    public async Task Graph_api_rejects_invalid_changes_and_round_trips_edits_undo_and_root_checks()
    {
        var store = DiskStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await using var host = await CreateApiAsync(graph, store, persist);
        var invalid = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root, changes = new[] { new { kind = "unknown" } },
        }, Token);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using var invalidBody = JsonDocument.Parse(await invalid.Content.ReadAsStringAsync(Token));
        Assert.False(invalidBody.RootElement.GetProperty("saved").GetBoolean());
        Assert.Equal(0, invalidBody.RootElement.GetProperty("snapshot").GetProperty("nodes").GetArrayLength());
        Assert.Equal(1, invalidBody.RootElement.GetProperty("rejected").GetArrayLength());
        Assert.Empty(graph.Current.Nodes);
        var request = new
        {
            expectedRoot = _root, requestId = Guid.NewGuid(), title = "Create",
            changes = new[] { new { kind = "add-node", node = new { id = "a", kind = "note", title = "A", x = 10, y = 20, status = "Done" } } },
        };
        var applied = await host.Client.PostAsJsonAsync("/api/graph/apply", request, Token);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        using var appliedBody = JsonDocument.Parse(await applied.Content.ReadAsStringAsync(Token));
        Assert.True(appliedBody.RootElement.GetProperty("saved").GetBoolean());
        Assert.True(appliedBody.RootElement.GetProperty("snapshot").GetProperty("canUndo").GetBoolean());
        Assert.True(appliedBody.RootElement.GetProperty("snapshot").GetProperty("hasSavedGraph").GetBoolean());
        Assert.Equal(GraphNodeState.Done, Assert.Single(graph.Current.Nodes).Status);
        Assert.Equal(HttpStatusCode.OK, (await host.Client.PostAsJsonAsync("/api/graph/apply", request, Token)).StatusCode);
        Assert.Single(graph.Timeline);
        var edited = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root,
            changes = new[] { new { kind = "update-node", nodeId = "a", nodeKind = "Module", width = 345, height = 123, path = "src/a.cs" } },
        }, Token);
        Assert.Equal(HttpStatusCode.OK, edited.StatusCode);
        Assert.Equal(GraphNodeKind.Module, graph.Current.Nodes[0].Kind);
        Assert.Equal((345d, 123d, "src/a.cs"), (graph.Current.Nodes[0].Width, graph.Current.Nodes[0].Height, graph.Current.Nodes[0].Path));
        var rejected = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root,
            changes = new[] { new { kind = "move-node", nodeId = "missing", x = 1, y = 2 } },
        }, Token);
        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        using var rejectedBody = JsonDocument.Parse(await rejected.Content.ReadAsStringAsync(Token));
        Assert.False(rejectedBody.RootElement.GetProperty("saved").GetBoolean());
        Assert.Equal(0, rejectedBody.RootElement.GetProperty("applied").GetInt32());
        Assert.Equal("a", rejectedBody.RootElement.GetProperty("snapshot").GetProperty("nodes")[0].GetProperty("id").GetString());
        Assert.Equal(345, rejectedBody.RootElement.GetProperty("snapshot").GetProperty("nodes")[0].GetProperty("width").GetDouble());
        Assert.Equal(HttpStatusCode.Conflict, (await host.Client.GetAsync("/api/graph?expectedRoot=" + Uri.EscapeDataString("wrong-project"), Token)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await host.Client.PostAsJsonAsync("/api/graph/viewport", new { expectedRoot = "wrong-project", zoom = 1, panX = 0, panY = 0 }, Token)).StatusCode);
        var undo = await host.Client.PostAsync("/api/graph/undo?expectedRoot=" + Uri.EscapeDataString(_root), null, Token);
        Assert.Equal(HttpStatusCode.OK, undo.StatusCode);
        Assert.Equal(GraphNodeKind.Note, graph.Current.Nodes[0].Kind);
        var annotated = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root,
            changes = new[] { new { kind = "update-node", nodeId = "a", subtitle = "Metadata", detail = "Annotation", path = "src/a.cs" } },
        }, Token);
        Assert.Equal(HttpStatusCode.OK, annotated.StatusCode);
        var cleared = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root,
            changes = new[] { new { kind = "update-node", nodeId = "a", subtitle = "", detail = "", path = "" } },
        }, Token);
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        Assert.Equal(("", "", ""), (graph.Current.Nodes[0].Subtitle, graph.Current.Nodes[0].Detail, graph.Current.Nodes[0].Path));
        var viewport = await host.Client.PostAsJsonAsync("/api/graph/viewport", new { expectedRoot = _root, zoom = 0.4, panX = 11, panY = 12 }, Token);
        Assert.Equal(HttpStatusCode.OK, viewport.StatusCode);
        Assert.Equal(new GraphViewport(0.4, 11, 12), persist.Viewport);
        var saved = await host.Client.PostAsync("/api/graph/save?expectedRoot=" + Uri.EscapeDataString(_root), null, Token);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        using var savedBody = JsonDocument.Parse(await saved.Content.ReadAsStringAsync(Token));
        Assert.True(savedBody.RootElement.GetProperty("saved").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await host.Client.PostAsync("/api/workspace/close", null, Token)).StatusCode);
        Assert.Empty(graph.Current.Nodes);
        Assert.Equal(HttpStatusCode.OK, (await host.Client.PostAsJsonAsync("/api/workspace/open", new { directory = _root }, Token)).StatusCode);
        var reopened = await host.Client.GetAsync("/api/graph?expectedRoot=" + Uri.EscapeDataString(_root), Token);
        Assert.Equal(HttpStatusCode.OK, reopened.StatusCode);
        using var reopenedBody = JsonDocument.Parse(await reopened.Content.ReadAsStringAsync(Token));
        var snapshot = reopenedBody.RootElement;
        Assert.Equal(_root, snapshot.GetProperty("workspaceRoot").GetString());
        Assert.True(snapshot.GetProperty("hasSavedGraph").GetBoolean());
        Assert.False(snapshot.GetProperty("canUndo").GetBoolean());
        Assert.Equal("saved", snapshot.GetProperty("persistence").GetProperty("state").GetString());
        Assert.Equal(1, snapshot.GetProperty("nodes").GetArrayLength());
        Assert.Equal("", snapshot.GetProperty("nodes")[0].GetProperty("detail").GetString());
        Assert.Equal("", snapshot.GetProperty("nodes")[0].GetProperty("subtitle").GetString());
        Assert.Equal("", snapshot.GetProperty("nodes")[0].GetProperty("path").GetString());
        Assert.Equal(0.4, snapshot.GetProperty("viewport").GetProperty("zoom").GetDouble());
        Assert.Equal(11, snapshot.GetProperty("viewport").GetProperty("panX").GetDouble());
        Assert.Equal(12, snapshot.GetProperty("viewport").GetProperty("panY").GetDouble());
    }

    [Fact]
    public async Task Graph_api_reports_an_applied_edit_with_save_failure_then_retries_only_the_save()
    {
        var store = new TestStore();
        var graph = new GraphService(store);
        var persist = Persist(graph, store);
        await persist.InitializeAsync(Token);
        await using var host = await CreateApiAsync(graph, store, persist);
        store.FailWrites = true;
        var applied = await host.Client.PostAsJsonAsync("/api/graph/apply", new
        {
            expectedRoot = _root, requestId = Guid.NewGuid(),
            changes = new[] { new { kind = "add-node", node = new { id = "a", kind = "note", title = "A", x = 0, y = 0 } } },
        }, Token);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        using var body = JsonDocument.Parse(await applied.Content.ReadAsStringAsync(Token));
        Assert.Equal(1, body.RootElement.GetProperty("applied").GetInt32());
        Assert.False(body.RootElement.GetProperty("saved").GetBoolean());
        Assert.False(body.RootElement.GetProperty("persistence").GetProperty("privateSaved").GetBoolean());
        store.FailWrites = false;
        var saved = await host.Client.PostAsync("/api/graph/save?expectedRoot=" + Uri.EscapeDataString(_root), null, Token);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        using var savedBody = JsonDocument.Parse(await saved.Content.ReadAsStringAsync(Token));
        Assert.True(savedBody.RootElement.GetProperty("saved").GetBoolean());
        Assert.Single(graph.Current.Nodes);
        Assert.Single(graph.Timeline);
    }

    private async Task<ApiHost> CreateApiAsync(GraphService graph, IGraphStore store, GraphPersistence persist)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddInfrastructure(builder.Configuration);
        builder.Services.AddSingleton<IAppPaths>(_paths);
        builder.Services.AddSingleton<IWorkspaceService>(_workspace);
        builder.Services.AddSingleton<IGraphStore>(store);
        builder.Services.AddSingleton<IGraphService>(graph);
        builder.Services.AddSingleton(persist);
        builder.Services.AddSingleton<GraphWriteRegistry>();
        builder.Services.AddSingleton<JsonCheckpointStore>();
        builder.Services.AddSingleton(new SidecarToken("graph-integration-tests"));
        builder.Services.AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(SidecarTokenHandler.SchemeName, _ => { });
        SidecarAuthorization.Configure(builder.Services);
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        DataEndpoints.Map(app);
        await app.StartAsync(Token);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "graph-integration-tests");
        return new ApiHost(app, client);
    }

    private sealed record ApiHost(WebApplication App, HttpClient Client) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() { Client.Dispose(); await App.DisposeAsync(); }
    }

    private sealed class TestStore : IGraphStore
    {
        private readonly Dictionary<string, GraphSnapshot> _saved = [];
        public bool FailWrites { get; set; }
        public TaskCompletionSource? PauseWrites { get; set; }
        public TaskCompletionSource WriteStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task SaveAsync(string key, GraphSnapshot snapshot, CancellationToken cancellationToken = default)
        {
            if (FailWrites) { throw new IOException("Disk is full."); }
            if (PauseWrites is { } paused)
            {
                WriteStarted.TrySetResult();
                await paused.Task.WaitAsync(cancellationToken);
            }
            _saved[key] = snapshot;
        }
        public Task<GraphSnapshot?> LoadAsync(string key, CancellationToken cancellationToken = default) =>
            Task.FromResult(_saved.GetValueOrDefault(key));
    }
}

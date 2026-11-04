using AIClient.Application.Graph;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;
using AIClient.Server;

namespace AIClient.Tests;

public sealed class GraphConcurrencyTests
{
    [Fact]
    public async Task An_edit_waits_for_a_pending_load_and_is_not_overwritten_by_its_response()
    {
        var loaded = new TaskCompletionSource<GraphSnapshot?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var graph = new GraphService(new DelayedStore(loaded.Task));
        var load = graph.LoadAsync("workspace:B");
        var edit = graph.ApplyAsync(new GraphChangeSet
        {
            Title = "edit",
            Origin = GraphChangeOrigin.User,
            Changes = [new AddNode(new GraphNode { Id = "edit", Title = "edit", Kind = GraphNodeKind.File })],
        });
        Assert.False(edit.IsCompleted);
        loaded.SetResult(new GraphSnapshot { Nodes = [new GraphNode { Id = "loaded", Title = "loaded", Kind = GraphNodeKind.File }] });
        await Task.WhenAll(load, edit);
        Assert.Equal(new[] { "edit", "loaded" }, graph.Current.Nodes.Select(n => n.Id).Order());
    }

    [Fact]
    public void A_conversation_accepts_only_one_live_run_and_is_released_after_finish()
    {
        var registry = new RunRegistry();
        var conversation = Guid.NewGuid();
        var first = Guid.NewGuid();
        Assert.NotNull(registry.Start(first, conversation));
        Assert.Null(registry.Start(Guid.NewGuid(), conversation));
        registry.Finish(first);
        var second = Guid.NewGuid();
        Assert.NotNull(registry.Start(second, conversation));
        registry.Finish(second);
    }

    [Fact]
    public async Task Retrying_a_graph_request_reuses_the_result_without_an_extra_history_step()
    {
        var graph = new GraphService(new DelayedStore(Task.FromResult<GraphSnapshot?>(null)));
        var writes = new GraphWriteRegistry();
        var id = Guid.NewGuid();
        var changes = new GraphChangeSet
        {
            Title = "add", Origin = GraphChangeOrigin.User,
            Changes = [new AddNode(new GraphNode { Id = "file", Title = "file", Kind = GraphNodeKind.File })],
        };
        var first = await writes.ApplyAsync(id, "same payload", changes, graph, CancellationToken.None);
        var retry = await writes.ApplyAsync(id, "same payload", changes, graph, CancellationToken.None);
        Assert.Equal(first, retry);
        Assert.Single(graph.Timeline);
        Assert.Single(graph.Current.Nodes);
        await Assert.ThrowsAsync<InvalidOperationException>(() => writes.ApplyAsync(id, "other payload", changes, graph, CancellationToken.None));
    }

    private sealed class DelayedStore(Task<GraphSnapshot?> load) : IGraphStore
    {
        public Task SaveAsync(string key, GraphSnapshot snapshot, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<GraphSnapshot?> LoadAsync(string key, CancellationToken cancellationToken = default) => load.WaitAsync(cancellationToken);
    }
}

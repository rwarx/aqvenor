using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Tests.Support;

/// <summary>
/// An in-memory graph for tests that need a canvas behind the system under
/// test. The snapshot is settable, so focus/context tests can draw the exact
/// nodes the case needs; everything mutating is a no-op.
/// </summary>
public sealed class StubGraphService : IGraphService
{
    public StubGraphService(GraphSnapshot? snapshot = null)
    {
        Current = snapshot ?? GraphSnapshot.Empty;
    }

    public GraphSnapshot Current { get; set; }

    public event EventHandler<GraphSnapshotChangedEventArgs>? SnapshotChanged
    {
        add { }
        remove { }
    }

    public IReadOnlyList<GraphTimelineEntry> Timeline => [];

    public event EventHandler? TimelineChanged
    {
        add { }
        remove { }
    }

    public bool CanUndo => false;

    public bool CanRedo => false;

    private static Task<GraphMutationResult> Empty() => Task.FromResult(new GraphMutationResult
    {
        Snapshot = GraphSnapshot.Empty,
        Applied = [],
        Rejected = [],
    });

    public Task<GraphMutationResult> ApplyAsync(GraphChangeSet changeSet, CancellationToken cancellationToken = default) =>
        Empty();

    public Task<GraphMutationResult> UndoAsync(CancellationToken cancellationToken = default) => Empty();

    public Task<GraphMutationResult> RedoAsync(CancellationToken cancellationToken = default) => Empty();

    public Task SaveAsync(string key, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task<GraphSnapshot> LoadAsync(string key, CancellationToken cancellationToken = default) =>
        Task.FromResult(GraphSnapshot.Empty);
}

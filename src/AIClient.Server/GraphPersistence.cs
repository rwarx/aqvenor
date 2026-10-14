using AIClient.Application.Interfaces;

namespace AIClient.Server;

/// <summary>
/// Keeps the graph store in step with the open workspace: loads the workspace's
/// graph when a folder opens, and saves it after every mutation.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors what the WPF shell's workspace view model does with
/// <c>WorkspaceGraphKeys</c>, minus the view layer. One key per workspace root,
/// so switching folders never mixes drawings.
/// </para>
/// <para>
/// Persistence is the host's job, not the graph service's (the service says so itself),
/// and in this build the host's policy is: save on folder swap, and otherwise save
/// shortly after the graph goes quiet. The quiet-save is debounced because a reindex and
/// the agent's canvas tools both apply many change sets back to back, and writing the
/// whole document once per change would be a write storm for no gain - the file only has
/// to be right once the dust settles.
/// </para>
/// </remarks>
public sealed class GraphPersistence : IDisposable
{
    /// <summary>
    /// How long the graph must stay unchanged before an auto-save fires. Long enough to
    /// swallow a burst of change sets, short enough that a crash loses only the last breath.
    /// </summary>
    private static readonly TimeSpan SaveDebounce = TimeSpan.FromMilliseconds(750);

    private readonly IGraphService _graph;
    private readonly IWorkspaceService _workspace;
    private readonly ILogger<GraphPersistence> _logger;
    private readonly Timer _saveTimer;
    private readonly object _gate = new();
    private string _currentKey = "workspace:none";
    private bool _disposed;

    public GraphPersistence(
        IGraphService graph,
        IWorkspaceService workspace,
        ILogger<GraphPersistence> logger)
    {
        _graph = graph;
        _workspace = workspace;
        _logger = logger;

        // Created idle: each snapshot change nudges it forward, and it fires once the
        // changes stop. One timer for the process, reset rather than recreated per change.
        _saveTimer = new Timer(_ => _ = FlushAsync(), null, Timeout.Infinite, Timeout.Infinite);

        _workspace.RootChanged += OnRootChanged;
        _graph.SnapshotChanged += OnSnapshotChanged;
    }

    public static string KeyForRoot(string? root) =>
        string.IsNullOrEmpty(root) ? "workspace:none" : "workspace:" + root;

    /// <summary>Loads the graph for the already-open workspace. Called once at startup.</summary>
    public async Task InitializeAsync(CancellationToken ct = default)
    {
        _currentKey = KeyForRoot(_workspace.Root);
        await _graph.LoadAsync(_currentKey, ct).ConfigureAwait(false);
    }

    /// <summary>Persists the current graph under the current workspace key.</summary>
    public Task SaveCurrentAsync(CancellationToken ct = default) =>
        _graph.SaveAsync(_currentKey, ct);

    private void OnRootChanged(object? sender, string? root)
    {
        // Fire-and-forget is honest here: the event has no async contract, and a
        // failed save is logged rather than thrown into whoever opened the folder.
        _ = SwapAsync(root);
    }

    private async Task SwapAsync(string? root)
    {
        try
        {
            await _graph.SaveAsync(_currentKey).ConfigureAwait(false);
            _currentKey = KeyForRoot(root);
            await _graph.LoadAsync(_currentKey).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "The graph could not be swapped for the new workspace root.");
        }
    }

    private void OnSnapshotChanged(object? sender, GraphSnapshotChangedEventArgs e)
    {
        // A reload is another document arriving (startup load, folder swap) - it is already
        // on disk, so re-saving it is pointless and, mid-swap, would write under a key that
        // is changing. Only steps within the current document are worth persisting.
        if (e.IsReload)
        {
            return;
        }

        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            // Reset the countdown: the save lands once the changes go quiet, once, rather
            // than once per change in a burst.
            _saveTimer.Change(SaveDebounce, Timeout.InfiniteTimeSpan);
        }
    }

    private async Task FlushAsync()
    {
        try
        {
            await SaveCurrentAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A failed auto-save is logged, never thrown: the timer callback has nowhere to
            // throw to, and the next change will try again. Explicit saves still cover a swap.
            _logger.LogError(ex, "The graph could not be auto-saved after a change.");
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
        }

        _workspace.RootChanged -= OnRootChanged;
        _graph.SnapshotChanged -= OnSnapshotChanged;
        _saveTimer.Dispose();
    }
}

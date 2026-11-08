using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIClient.Application.Configuration;
using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;
using AIClient.Domain.Workspace;
using AIClient.Infrastructure.Graph;

namespace AIClient.Server;

public sealed record GraphPersistenceStatus(string State, bool PrivateSaved, string? Error = null, string? PortableError = null, long Revision = 0);

/// <summary>Owns persistence for the open graph, including its portable workspace copy and viewport.</summary>
public sealed class GraphPersistence : IDisposable
{
    private static readonly TimeSpan SaveDebounce = TimeSpan.FromMilliseconds(750);
    private static readonly WorkspacePath CanvasPath = WorkspacePath.Parse(".aqvenor/canvas.json");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly IGraphService _graph;
    private readonly IWorkspaceService _workspace;
    private readonly IGraphStore? _store;
    private readonly IAppPaths? _paths;
    private readonly ILogger<GraphPersistence> _logger;
    private readonly Timer _saveTimer;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _operations = new(1, 1);
    private readonly Dictionary<string, PortableGraphDocument> _retained = [];
    private readonly HashSet<string> _unreadableLayouts = new(StringComparer.OrdinalIgnoreCase);
    private string _currentKey = "workspace:none";
    private string? _root;
    private PortableGraphDocument _document = new() { Snapshot = GraphSnapshot.Empty };
    private string? _portableHash = "";
    private bool _portableReadable = true;
    private long _revision;
    private long _privateSavedRevision;
    private long _portableSavedRevision;
    private string? _error;
    private string? _portableError;
    private bool _loading;
    private bool _hasSavedGraph;
    private bool _disposed;
    private Task _ready = Task.CompletedTask;

    public GraphPersistence(IGraphService graph, IWorkspaceService workspace, ILogger<GraphPersistence> logger,
        IGraphStore? store = null, IAppPaths? paths = null)
    {
        _graph = graph;
        _workspace = workspace;
        _logger = logger;
        _store = store;
        _paths = paths;
        _saveTimer = new Timer(_ => _ = FlushAsync(), null, Timeout.Infinite, Timeout.Infinite);
        _workspace.RootChanged += OnRootChanged;
        _graph.SnapshotChanged += OnSnapshotChanged;
    }

    public static string KeyForRoot(string? root) => string.IsNullOrEmpty(root) ? "workspace:none" : "workspace:" + root;
    public string? WorkspaceRoot { get { lock (_gate) { return _root; } } }
    public GraphViewport Viewport { get { lock (_gate) { return _document.Viewport; } } }
    public long Revision { get { lock (_gate) { return _revision; } } }
    public bool HasSavedGraph { get { lock (_gate) { return _hasSavedGraph; } } }
    public GraphPersistenceStatus Status
    {
        get
        {
            lock (_gate)
            {
                var privateSaved = _revision == _privateSavedRevision;
                return new(_error is not null || _portableError is not null ? "error"
                    : privateSaved && _revision == _portableSavedRevision ? "saved" : "pending",
                    privateSaved, _error, _portableError, _revision);
            }
        }
    }

    public Task InitializeAsync(CancellationToken ct = default)
    {
        var root = _workspace.Root;
        var pinned = _workspace.AcquireLease(root);
        if (!pinned.Success) { throw new InvalidOperationException(pinned.Error); }
        lock (_gate) { _ready = LoadInitialAsync(root, pinned.Value!, ct); return _ready; }
    }

    private async Task LoadInitialAsync(string? root, IWorkspaceLease lease, CancellationToken ct)
    {
        using var pinned = lease;
        await _operations.WaitAsync(ct).ConfigureAwait(false);
        try { await LoadRootAsync(root, ct).ConfigureAwait(false); }
        finally { _operations.Release(); }
    }

    public Task WaitForReadyAsync(CancellationToken ct = default)
    {
        lock (_gate) { return _ready.WaitAsync(ct); }
    }

    /// <summary>Attempts both durable copies. A failed write remains pending and is reported to the caller.</summary>
    public async Task<GraphPersistenceStatus> SaveCurrentAsync(CancellationToken ct = default)
    {
        await WaitForReadyAsync(ct).ConfigureAwait(false);
        var pinned = _workspace.AcquireLease(WorkspaceRoot);
        if (!pinned.Success) { throw new InvalidOperationException(pinned.Error); }
        using var lease = pinned.Value!;
        await _operations.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            PortableGraphDocument document;
            long revision;
            lock (_gate) { document = _document with { Snapshot = _graph.Current }; revision = _revision; }
            await SavePrivateAsync(_currentKey, document, revision, ct).ConfigureAwait(false);
            await SavePortableAsync(document, revision, ct).ConfigureAwait(false);
            return Status;
        }
        finally { _operations.Release(); }
    }

    public async Task<GraphPersistenceStatus> SetViewportAsync(GraphViewport viewport, CancellationToken ct = default)
    {
        if (!viewport.IsValid) { throw new ArgumentException("The graph viewport is invalid.", nameof(viewport)); }
        await WaitForReadyAsync(ct).ConfigureAwait(false);
        lock (_gate)
        {
            if (_document.Viewport != viewport)
            {
                _document = _document with { Viewport = viewport };
                MarkPending();
            }
        }
        return await SaveCurrentAsync(ct).ConfigureAwait(false);
    }

    private void OnRootChanged(object? sender, string? root)
    {
        var pinned = _workspace.AcquireLease(root);
        if (!pinned.Success) { throw new InvalidOperationException(pinned.Error); }
        lock (_gate) { _ready = SwapAsync(_ready, root, pinned.Value!); }
    }

    private async Task SwapAsync(Task previous, string? root, IWorkspaceLease lease)
    {
        using var pinned = lease;
        await previous.ConfigureAwait(false);
        await _operations.WaitAsync().ConfigureAwait(false);
        try
        {
            PortableGraphDocument document;
            long revision;
            lock (_gate) { document = _document with { Snapshot = _graph.Current }; revision = _revision; }
            // The workspace event is raised after its root changes: only the private store can
            // still save the outgoing document here. HTTP switching flushes its portable file first.
            await SavePrivateAsync(_currentKey, document, revision, CancellationToken.None).ConfigureAwait(false);
            if (!Status.PrivateSaved || _portableSavedRevision != revision)
            {
                _retained[_currentKey] = document;
            }
            else { _retained.Remove(_currentKey); }
            await LoadRootAsync(root, CancellationToken.None).ConfigureAwait(false);
        }
        finally { _operations.Release(); }
    }

    private async Task LoadRootAsync(string? root, CancellationToken ct)
    {
        var key = KeyForRoot(root);
        GraphSnapshot? stored = null;
        string? privateError = null;
        if (_store is not null)
        {
            try
            {
                stored = await _store.LoadAsync(key, ct).ConfigureAwait(false);
                privateError = (_store as IGraphStoreDiagnostics)?.LastLoadError;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                privateError = "The saved graph could not be loaded: " + ex.Message;
                _logger.LogError(ex, "The private graph could not be loaded.");
            }
        }
        var document = new PortableGraphDocument { Snapshot = stored ?? GraphSnapshot.Empty };
        string? portableHash = "";
        string? portableError = null;
        var portableReadable = true;
        PortableGraphDocument? portable = null;
        var portableExists = false;
        if (root is not null)
        {
            var stat = await _workspace.StatAsync(CanvasPath, ct).ConfigureAwait(false);
            if (stat.Success)
            {
                portableExists = true;
                var read = await _workspace.ReadDocumentAsync(CanvasPath, ct).ConfigureAwait(false);
                if (read.Success && read.Value is { IsTruncated: false } file)
                {
                    portableHash = file.ContentHash;
                    try { portable = PortableGraphDocument.Parse(file.Content); }
                    catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
                    {
                        portableError = "The portable canvas could not be loaded: " + ex.Message;
                        portableReadable = false;
                    }
                }
                else { portableError = read.Error ?? "The portable canvas is incomplete."; portableReadable = false; }
            }
            else if (stat.Error?.Contains("does not exist", StringComparison.OrdinalIgnoreCase) != true)
            {
                portableExists = true;
                portableError = stat.Error ?? "The portable canvas could not be inspected.";
                portableReadable = false;
            }
        }
        if (portable is not null) { document = portable with { Snapshot = stored ?? portable.Snapshot }; }
        var (layout, layoutError) = await ReadLayoutAsync(key, ct).ConfigureAwait(false);
        privateError ??= layoutError;
        if (layout is not null)
        {
            var metadata = new Dictionary<string, JsonElement>(layout.AdditionalData);
            foreach (var pair in document.AdditionalData) { metadata[pair.Key] = pair.Value; }
            document = document with { Viewport = layout.Viewport, AdditionalData = metadata };
        }
        var retained = _retained.TryGetValue(key, out var unsaved);
        if (retained) { document = unsaved!; }
        var imported = stored is null && portable is not null;
        lock (_gate)
        {
            _currentKey = key;
            _root = root;
            _document = document;
            _portableHash = portableHash;
            _portableReadable = portableReadable;
            _hasSavedGraph = stored is not null || portableExists || retained || privateError is not null;
            _error = privateError;
            _portableError = portableError;
            _loading = true;
        }
        GraphSnapshot loadedSnapshot;
        try
        {
            if (_store is null && !retained) { loadedSnapshot = await _graph.LoadAsync(key, ct).ConfigureAwait(false); }
            else { loadedSnapshot = await _graph.RestoreAsync(document.Snapshot, ct).ConfigureAwait(false); }
        }
        finally { lock (_gate) { _loading = false; } }
        lock (_gate)
        {
            var changedDuringLoad = !loadedSnapshot.Equals(_graph.Current);
            _document = _document with { Snapshot = _graph.Current };
            _hasSavedGraph |= changedDuringLoad || loadedSnapshot.Nodes.Count > 0 || loadedSnapshot.Edges.Count > 0;
            _revision++;
            _privateSavedRevision = imported || retained || privateError is not null || changedDuringLoad ? _revision - 1 : _revision;
            _portableSavedRevision = root is null || portable is not null && portable.Snapshot.Equals(_graph.Current)
                && portable.Viewport == document.Viewport && !retained ? _revision : _revision - 1;
            if (_hasSavedGraph && (privateError is null || imported || retained)
                && (_privateSavedRevision != _revision || _portableSavedRevision != _revision)) { ScheduleSave(); }
        }
    }

    private async Task SavePrivateAsync(string key, PortableGraphDocument document, long revision, CancellationToken ct)
    {
        try
        {
            if (_store is null) { await _graph.SaveAsync(key, ct).ConfigureAwait(false); }
            else { await _store.SaveAsync(key, document.Snapshot, ct).ConfigureAwait(false); }
            await SaveLayoutAsync(key, document, ct).ConfigureAwait(false);
            lock (_gate) { _privateSavedRevision = revision; _error = null; _hasSavedGraph = true; }
            _retained.Remove(key);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            lock (_gate) { _error = "The graph could not be saved: " + ex.Message; }
            _retained[key] = document;
            _logger.LogError(ex, "The private graph could not be saved.");
        }
    }

    private async Task SavePortableAsync(PortableGraphDocument document, long revision, CancellationToken ct)
    {
        if (_root is null) { lock (_gate) { _portableSavedRevision = revision; } return; }
        if (!_portableReadable) { return; }
        try
        {
            var write = await _workspace.WriteAsync(CanvasPath, document.Serialize(), ct,
                expectedHash: _portableHash, preserveNewlines: true).ConfigureAwait(false);
            lock (_gate)
            {
                if (write.Success)
                {
                    _portableHash = write.Value!.ContentHash;
                    _portableSavedRevision = revision;
                    _portableError = null;
                }
                else { _portableError = "The portable canvas could not be saved: " + write.Error; }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            lock (_gate) { _portableError = "The portable canvas could not be saved: " + ex.Message; }
            _logger.LogWarning(ex, "The portable graph could not be saved.");
        }
    }

    private string? LayoutPath(string key) => _paths is null ? null : Path.Combine(_paths.DataDirectory, "graphs",
        "~" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16].ToLowerInvariant() + ".layout.json");

    private async Task SaveLayoutAsync(string key, PortableGraphDocument document, CancellationToken ct)
    {
        if (LayoutPath(key) is not { } target) { return; }
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        if (_unreadableLayouts.Contains(target))
        {
            if (File.Exists(target))
            {
                var backupPath = await GraphRecoveryFiles.CreateAsync(target, _logger, ct).ConfigureAwait(false);
                _logger.LogWarning("Preserved unreadable graph layout '{File}' as '{Backup}' before saving.", target, backupPath);
            }
            _unreadableLayouts.Remove(target);
        }
        var temporary = target + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new PrivateLayout(document.Viewport, document.AdditionalData), Json), ct)
                .ConfigureAwait(false);
            File.Move(temporary, target, overwrite: true);
        }
        finally { if (File.Exists(temporary)) { File.Delete(temporary); } }
    }

    private async Task<(PrivateLayout? Layout, string? Error)> ReadLayoutAsync(string key, CancellationToken ct)
    {
        if (LayoutPath(key) is not { } target) { return (null, null); }
        if (!File.Exists(target)) { _unreadableLayouts.Remove(target); return (null, null); }
        try
        {
            var layout = JsonSerializer.Deserialize<PrivateLayout>(await File.ReadAllTextAsync(target, ct).ConfigureAwait(false), Json);
            if (layout is { Viewport.IsValid: true, AdditionalData: not null })
            {
                _unreadableLayouts.Remove(target);
                return (layout, null);
            }
            _unreadableLayouts.Add(target);
            return (null, "The saved graph viewport has invalid content.");
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            _unreadableLayouts.Add(target);
            _logger.LogWarning(ex, "The saved graph viewport could not be loaded.");
            return (null, "The saved graph viewport could not be loaded: " + ex.Message);
        }
    }

    private sealed record PrivateLayout(GraphViewport Viewport, Dictionary<string, JsonElement> AdditionalData);

    private void OnSnapshotChanged(object? sender, GraphSnapshotChangedEventArgs e)
    {
        lock (_gate)
        {
            if (_disposed || _loading && e.IsReload) { return; }
            _document = _document with { Snapshot = e.Snapshot };
            _hasSavedGraph = true;
            MarkPending();
        }
    }

    private void MarkPending() { _revision++; ScheduleSave(); }
    private void ScheduleSave() { if (!_disposed) { _saveTimer.Change(SaveDebounce, Timeout.InfiniteTimeSpan); } }

    private async Task FlushAsync()
    {
        try { await SaveCurrentAsync().ConfigureAwait(false); }
        catch (Exception ex) { _logger.LogError(ex, "The graph could not be auto-saved after a change."); }
    }

    public void Dispose()
    {
        lock (_gate) { _disposed = true; }
        _workspace.RootChanged -= OnRootChanged;
        _graph.SnapshotChanged -= OnSnapshotChanged;
        _saveTimer.Dispose();
    }
}

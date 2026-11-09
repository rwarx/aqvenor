using AIClient.Application.DTOs;

namespace AIClient.Server;

/// <summary>
/// Tracks in-flight chat/agent runs: their cancellation and their pending approvals.
/// </summary>
/// <remarks>
/// One entry per run id, created when a streaming request starts and removed when the
/// stream ends. Approvals arrive on a different HTTP request than the run itself, so
/// the run's wait has to live somewhere both requests can reach: here.
/// </remarks>
public sealed class RunRegistry
{
    /// <summary>
    /// How many runs may be in flight at once.
    /// </summary>
    /// <remarks>
    /// Each run holds a request open, a provider connection, and possibly a database write. There is
    /// no natural ceiling — the caller supplies the id, so it is not even bounded by the number of
    /// clients. Fifty is far above any real use and low enough that a runaway loop cannot exhaust the
    /// machine.
    /// </remarks>
    public const int MaxConcurrentRuns = 50;

    private readonly object _lock = new();
    private readonly Dictionary<Guid, RunEntry> _runs = new();
    private readonly Dictionary<Guid, ChildConversationLease> _children = new();

    /// <summary>
    /// Registers a run, or returns null when the id is already in flight or the ceiling is reached.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The dictionary indexer was used here, and that silently overwrote a live entry when a caller
    /// re-posted an id it had chosen itself. The displaced run's <see cref="CancellationTokenSource"/>
    /// was never disposed, its approval waiter was never signalled — so anything awaiting one waited
    /// for an answer that could never arrive — and whichever request finished first disposed that
    /// token while its sibling was still registering a callback on it.
    /// </para>
    /// <para>
    /// Refusing the duplicate is the whole fix. A caller that chose the id may retry it, but it gets
    /// told no rather than silently orphaning the run already using it.
    /// </para>
    /// </remarks>
    public RunEntry? Start(Guid runId, Guid? conversationId = null)
    {
        var entry = new RunEntry(runId);

        lock (_lock)
        {
            if (_runs.ContainsKey(runId) || (conversationId is { } conversation &&
                (_children.ContainsKey(conversation) || _runs.Values.Any(run => run.ConversationId == conversation))))
            {
                entry.Dispose();
                return null;
            }

            if (_runs.Count >= MaxConcurrentRuns)
            {
                entry.Dispose();
                return null;
            }

            entry.ConversationId = conversationId;
            _runs[runId] = entry;
        }

        return entry;
    }

    public void BindConversation(Guid runId, Guid conversationId)
    {
        lock (_lock)
        {
            if (_children.ContainsKey(conversationId) ||
                _runs.Values.Any(run => run.RunId != runId && run.ConversationId == conversationId))
            {
                throw new InvalidOperationException("A run is already active in this conversation.");
            }
            if (_runs.TryGetValue(runId, out var entry)) { entry.ConversationId = conversationId; }
        }
    }

    public bool TryGet(Guid runId, out RunEntry? entry)
    {
        lock (_lock)
        {
            return _runs.TryGetValue(runId, out entry);
        }
    }

    /// <summary>Reserves a child's transcript while its parent owns the execution and approvals.</summary>
    public IDisposable? TryReserveChild(Guid parentRunId, Guid conversationId)
    {
        lock (_lock)
        {
            if (!_runs.TryGetValue(parentRunId, out var parent) || parent.Cancellation.IsCancellationRequested ||
                _children.ContainsKey(conversationId) || _runs.Values.Any(run => run.ConversationId == conversationId))
            {
                return null;
            }

            var lease = new ChildConversationLease(this, parentRunId, conversationId);
            _children.Add(conversationId, lease);
            return lease;
        }
    }

    /// <summary>Whether a parent still owns this child's transcript, including cancellation cleanup.</summary>
    public bool IsChildConversationReserved(Guid conversationId)
    {
        lock (_lock)
        {
            return _children.ContainsKey(conversationId);
        }
    }

    private void ReleaseChild(ChildConversationLease lease)
    {
        lock (_lock)
        {
            // A delayed Dispose must not release a newer reservation after its parent finished.
            if (_children.TryGetValue(lease.ConversationId, out var current) && ReferenceEquals(current, lease))
            {
                _children.Remove(lease.ConversationId);
            }
        }
    }

    public void Finish(Guid runId)
    {
        RunEntry? entry;
        lock (_lock)
        {
            _runs.Remove(runId, out entry);
            foreach (var conversationId in _children.Where(child => child.Value.ParentRunId == runId).Select(child => child.Key).ToArray())
            {
                _children.Remove(conversationId);
            }
        }

        entry?.Finish();
    }

    private sealed class ChildConversationLease(RunRegistry owner, Guid parentRunId, Guid conversationId) : IDisposable
    {
        public Guid ParentRunId { get; } = parentRunId;
        public Guid ConversationId { get; } = conversationId;
        public void Dispose() => owner.ReleaseChild(this);
    }
}

/// <summary>Mutable state of one streaming run.</summary>
public sealed class RunEntry : IDisposable
{
    private readonly object _lifecycleLock = new();
    private readonly TaskCompletionSource _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _disposed;
    private TaskCompletionSource<AgentApprovalDecision>? _approvalWaiter;
    private PendingApproval? _pending;

    public RunEntry(Guid runId)
    {
        RunId = runId;
    }

    public Guid RunId { get; }
    public Guid? ConversationId { get; internal set; }

    public CancellationTokenSource Cancellation { get; } = new();

    /// <summary>Completes after the run has left its streaming handler and finished cleanup.</summary>
    public Task Completion => _completion.Task;

    /// <summary>The approval currently awaiting an answer, if any.</summary>
    public PendingApproval? PendingApproval
    {
        get
        {
            lock (this)
            {
                return _pending;
            }
        }
    }

    /// <summary>Called by the approval gate: publishes the question and waits.</summary>
    public async Task<AgentApprovalDecision> WaitForApprovalAsync(
        PendingApproval pending,
        CancellationToken cancellationToken)
    {
        TaskCompletionSource<AgentApprovalDecision> waiter;
        lock (this)
        {
            _pending = pending;
            waiter = new TaskCompletionSource<AgentApprovalDecision>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _approvalWaiter = waiter;
        }

        using var registration = cancellationToken.Register(
            () => waiter.TrySetCanceled(cancellationToken));

        try
        {
            return await waiter.Task.ConfigureAwait(false);
        }
        finally
        {
            lock (this)
            {
                _pending = null;
                _approvalWaiter = null;
            }
        }
    }

    /// <summary>Called by the approval-answer endpoint.</summary>
    public bool Answer(PendingApprovalAnswer answer)
    {
        lock (this)
        {
            if (_approvalWaiter is null || _pending is null || _pending.ApprovalId != answer.ApprovalId)
            {
                return false;
            }

            _approvalWaiter.TrySetResult(answer.Decision);
            return true;
        }
    }

    public void Cancel()
    {
        lock (_lifecycleLock)
        {
            if (!_disposed) { Cancellation.Cancel(); }
        }
    }

    internal void Finish()
    {
        Dispose();
        _completion.TrySetResult();
    }

    public void Dispose()
    {
        lock (_lifecycleLock)
        {
            if (_disposed) { return; }
            _disposed = true;
            Cancellation.Dispose();
        }
    }
}

/// <summary>One question the agent put to the user.</summary>
public sealed record PendingApproval
{
    public required Guid ApprovalId { get; init; }
    public required Guid RunId { get; init; }
    public required Guid ConversationId { get; init; }
    public required string ToolName { get; init; }
    public required string Risk { get; init; }
    public required string ArgumentsJson { get; init; }
    public string? Summary { get; init; }
    public string? Preview { get; init; }
    public bool IsRepeat { get; init; }
    public DateTimeOffset AskedAt { get; init; }
}

/// <summary>The user's answer to a pending approval.</summary>
public sealed record PendingApprovalAnswer
{
    public required Guid ApprovalId { get; init; }
    public required AgentApprovalDecision Decision { get; init; }
}

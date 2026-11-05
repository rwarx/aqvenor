namespace AIClient.Tests.Support;

/// <summary>A monotonic test clock with one-shot timers, advanced explicitly by the test.</summary>
internal sealed class ManualTimeProvider : TimeProvider
{
    private long _ticks;
    private readonly List<ManualTimer> _timers = [];
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    public override long GetTimestamp() => _ticks;

    public void Advance(TimeSpan elapsed)
    {
        _ticks += elapsed.Ticks;
        foreach (var timer in _timers.ToArray()) { timer.FireIfDue(_ticks); }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new ManualTimer(this, callback, state);
        _timers.Add(timer);
        timer.Change(dueTime, period);
        return timer;
    }

    private sealed class ManualTimer(ManualTimeProvider clock, TimerCallback callback, object? state) : ITimer
    {
        private long _due = long.MaxValue;
        private bool _disposed;
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            if (_disposed) { return false; }
            if (period != Timeout.InfiniteTimeSpan) { throw new NotSupportedException("Only one-shot timers are used by the run budget."); }
            _due = dueTime == Timeout.InfiniteTimeSpan ? long.MaxValue : clock._ticks + dueTime.Ticks;
            return true;
        }
        public void FireIfDue(long now)
        {
            if (_disposed || now < _due) { return; }
            _due = long.MaxValue;
            callback(state);
        }
        public void Dispose() { _disposed = true; }
        public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
    }
}

using AIClient.App.Infrastructure.Logging;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

/// <summary>
/// The file sink must honour a level change without a relaunch - that is the whole reason the
/// settings screen shows <c>MinimumLogLevel</c>.
/// </summary>
public sealed class FileLoggerProviderTests
{
    [Fact]
    public void SetMinimumLevel_applies_to_entries_written_after_the_call()
    {
        var dir = Path.Combine(Path.GetTempPath(), "aiclient-logtest", Guid.CreateVersion7().ToString("n"));

        try
        {
            using var provider = new FileLoggerProvider(dir, LogLevel.Information, retentionDays: 7);
            var logger = provider.CreateLogger("Test");

            Assert.False(logger.IsEnabled(LogLevel.Debug));
            Assert.True(logger.IsEnabled(LogLevel.Warning));

            provider.SetMinimumLevel(LogLevel.Debug);

            Assert.True(logger.IsEnabled(LogLevel.Debug));
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
                // A leftover temp folder is not worth failing the suite over.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}

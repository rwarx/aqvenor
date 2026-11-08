using System.Security.Cryptography;
using Microsoft.Extensions.Logging;

namespace AIClient.Infrastructure.Graph;

/// <summary>Preserves unreadable graph documents before a recovery save replaces them.</summary>
public static class GraphRecoveryFiles
{
    public static async Task<string> CreateAsync(string target, ILogger logger, CancellationToken cancellationToken)
    {
        var backupPath = Path.Combine(Path.GetDirectoryName(target)!,
            Path.GetFileNameWithoutExtension(target) + ".corrupt-" + Guid.NewGuid().ToString("N") + ".json");
        var backupCreated = false;
        try
        {
            await using var source = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 81920, FileOptions.Asynchronous | FileOptions.SequentialScan);
            await using var backup = new FileStream(backupPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                bufferSize: 81920, FileOptions.Asynchronous | FileOptions.SequentialScan);
            backupCreated = true;
            await source.CopyToAsync(backup, cancellationToken).ConfigureAwait(false);
            await backup.FlushAsync(cancellationToken).ConfigureAwait(false);
            backup.Flush(flushToDisk: true);
            source.Position = 0;
            backup.Position = 0;
            var originalHash = await SHA256.HashDataAsync(source, cancellationToken).ConfigureAwait(false);
            var backupHash = await SHA256.HashDataAsync(backup, cancellationToken).ConfigureAwait(false);
            if (!CryptographicOperations.FixedTimeEquals(originalHash, backupHash))
            {
                throw new IOException("The damaged graph recovery copy could not be verified.");
            }
        }
        catch
        {
            if (backupCreated)
            {
                try { File.Delete(backupPath); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    logger.LogWarning(ex, "Incomplete graph recovery copy '{File}' could not be removed.", backupPath);
                }
            }
            throw;
        }
        return backupPath;
    }
}

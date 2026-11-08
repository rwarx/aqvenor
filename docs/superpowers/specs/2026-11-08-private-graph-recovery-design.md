# Private graph recovery

The private graph may fail to deserialize while the application remains usable with an empty graph. A later close-save must preserve the damaged source before replacing it.

`JsonGraphStore` tracks the resolved filename of failed loads. The next save creates a unique sibling `<stem>.corrupt-<guid>.json` with `FileMode.CreateNew`, copies the source bytes while denying concurrent writes, flushes the copy, and verifies its SHA256 against the source. It never overwrites a previous backup. A preservation failure propagates before the replacement is written, leaves the source intact, and retains recovery state for retry. A successful backup is needed once per failed load, without a global save lock.

The parent approved this bounded recovery fix on 8 November 2026 and extended it to the private layout document. `GraphPersistence` tracks failed layout loads and uses the same `GraphRecoveryFiles.CreateAsync` procedure before replacing the viewport/metadata source. Invalid null node/edge entries are refused through the normal recoverable-load path. Both components keep their existing startup and close-save behavior.

# Knowledge Base Resource Management

The Admin UI supports editing knowledge-base details and maintaining uploaded Markdown resources.

## Knowledge base details

Open the card menu and select **Edit** to update the knowledge-base name and description. The card and sidebar use the saved values immediately. Published navigation files receive the updated values when publication completes.

## Files

Open a file menu in the file tree to rename the file, move it to another uploaded directory, replace its complete Markdown content, or delete it. File names must end with `.md`. Replacement accepts text entered in the editor or a local `.md` file.

The file keeps its stable source file ID after rename, move, and replacement. Existing generated content remains readable while an accepted change is being processed.

## Directories

Open a directory menu to rename, move, or delete the directory. The destination picker loads uploaded source directories as they are opened. It prevents selecting the current directory or one of its descendants as the destination.

Directory changes apply to every descendant path when publication completes. Directory deletion includes all descendant source files.

## Concurrent changes

The Admin UI disables a resource menu while an accepted change is active. A stale resource, occupied path, processing file, or deleting resource produces a clear message. Reload the current tree before retrying a stale change. Choose another destination when a path is occupied.

Admin UI changes and Developer OpenAPI changes use the same resource IDs, revision checks, operation states, and final generated file tree.

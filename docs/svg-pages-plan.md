# SVG pages

1. Add a brush button and Command+B to the text editor. Insert a standalone `\svgpage[filename.svg]` line at the cursor, keeping the text on either side editable.
2. Use CodeMirror block decorations to show an SVG preview when the selection is outside the directive. Keep the directive as ordinary movable text while selected. Open the inline editor by clicking its preview.
3. Save drawings as sibling SVG files in OPFS. For machine notes, store the SVG in OPFS and associate it with the note’s folder in the graph. Register them as drawing file states and include saved references in the source file's outgoing transitions. Preserve plain-text handling of SVG files that are not Notework drawings.
4. Share one stroke editor between inline and standalone drawing states. Inline mode replaces the text toolbar and keeps the text draft; standalone Exit returns to file navigation. Drawing saves and exits use the existing explicit-save and unsaved-changes conventions.
5. Use pointer input for stroke approximation and whole-stroke erasing, with undo and redo. Show one working page (16 min-box units) below the existing strokes. Freeze that limit during each new stroke and omit the unused working area from the saved SVG.
6. Test insertion and moving the directive, inline and standalone editing, toolbar swaps, stroke history and bounds, SVG persistence, and graph navigation.

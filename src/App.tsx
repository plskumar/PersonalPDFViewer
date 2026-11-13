import {
  ChangeEvent,
  ComponentProps,
  PointerEvent as ReactPointerEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  FilePlus2,
  Files,
  Download,
  FolderOpen,
  GripVertical,
  Highlighter,
  Maximize,
  MessageSquareText,
  Minus,
  MousePointer2,
  Plus,
  Search,
  StickyNote,
  TextSelect,
  X,
} from 'lucide-react';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type WritableFileHandle = {
  createWritable: () => Promise<{
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
};
type FolderEntry = { kind: string; name: string; getFile?: () => Promise<File> };
type SourceFolderHandle = {
  values: () => AsyncIterableIterator<FolderEntry>;
  getFileHandle: (name: string, options: { create: true }) => Promise<WritableFileHandle>;
};
type PdfFile = { id: string; file: File; sourceFolder?: SourceFolderHandle };
type PdfDocument = Parameters<NonNullable<ComponentProps<typeof Document>['onLoadSuccess']>>[0];
type Tool = 'pan' | 'text' | 'note';
type Mark = { id: string; page: number; x: number; y: number; width: number; height: number };
type PendingHighlight = { page: number; text: string; rects: Omit<Mark, 'id'>[] };
type Note = { id: string; page: number; x: number; y: number; text: string };
type SearchHit = { page: number; text: string };

export type PaneHandle = {
  previousPage: () => void;
  nextPage: () => void;
  goToPage: (page: number) => void;
  zoom: (amount: number) => void;
  resetZoom: () => void;
  find: (term: string, direction: 1 | -1) => void;
  setTool: (tool: Tool) => void;
  scrollBy: (amount: number) => void;
  getScrollMetrics: () => { top: number; maxTop: number; page: number; pageCount: number };
  turnPage: (direction: 1 | -1) => void;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
      character
    ] as string,
  );

const highlightText = (text: string, term: string) => {
  if (!term.trim()) return escapeHtml(text);
  const expression = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return text
    .split(expression)
    .map((part) =>
      part.toLowerCase() === term.toLowerCase()
        ? `<mark class="search-mark">${escapeHtml(part)}</mark>`
        : escapeHtml(part),
    )
    .join('');
};

type PaneProps = {
  item: PdfFile;
  query: string;
  register: (id: string, handle: PaneHandle | null) => void;
  onRemove: (id: string) => void;
  allowRemove: boolean;
};

const PdfPane = forwardRef<PaneHandle, PaneProps>(function PdfPane(
  { item, query, register, onRemove, allowRemove },
  ref,
) {
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('pan');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchRevision, setSearchRevision] = useState(0);
  const [highlights, setHighlights] = useState<Mark[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadingText, setLoadingText] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pageInput, setPageInput] = useState('1');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingHighlightRef = useRef<PendingHighlight | null>(null);
  const pendingPageAlignmentRef = useRef<'top' | 'bottom' | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    pointerType: string;
  } | null>(null);

  useEffect(() => {
    setPage(1);
    setPageInput('1');
    setDocument(null);
    setPageCount(0);
    setHits([]);
    setHighlights([]);
    setNotes([]);
    setSearchRevision(0);
    pendingHighlightRef.current = null;
  }, [item.id]);

  useEffect(() => {
    const rememberSelection = () => {
      if (tool !== 'text') return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.toString().trim() || !scrollRef.current) return;
      const range = selection.getRangeAt(0);
      const pageElement = scrollRef.current.querySelector<HTMLElement>(
        `.page-shell[data-page="${page}"] .react-pdf__Page`,
      );
      if (!pageElement?.contains(range.commonAncestorContainer)) return;
      const pageRect = pageElement.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).flatMap((rect) => {
        const left = Math.max(rect.left, pageRect.left);
        const top = Math.max(rect.top, pageRect.top);
        const right = Math.min(rect.right, pageRect.right);
        const bottom = Math.min(rect.bottom, pageRect.bottom);
        if (right <= left || bottom <= top) return [];
        return [{
          page,
          x: (left - pageRect.left) / pageRect.width,
          y: (top - pageRect.top) / pageRect.height,
          width: (right - left) / pageRect.width,
          height: (bottom - top) / pageRect.height,
        }];
      });
      if (rects.length) {
        pendingHighlightRef.current = { page, text: selection.toString().trim(), rects };
      }
    };
    window.document.addEventListener('selectionchange', rememberSelection);
    return () => window.document.removeEventListener('selectionchange', rememberSelection);
  }, [page, tool]);

  useEffect(() => {
    setPageInput(String(page));
    pendingHighlightRef.current = null;
    const alignment = pendingPageAlignmentRef.current;
    pendingPageAlignmentRef.current = null;
    if (alignment) {
      window.requestAnimationFrame(() => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollTop = alignment === 'bottom' ? scrollRef.current.scrollHeight : 0;
      });
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [page]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    setLoadingText(true);
    const collectText = async () => {
      const found: SearchHit[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const pdfPage = await document.getPage(pageNumber);
        const content = await pdfPage.getTextContent();
        const text = content.items
          .map((entry) => ('str' in entry ? entry.str : ''))
          .join(' ');
        found.push({ page: pageNumber, text });
      }
      if (!cancelled) {
        setHits(found);
        setLoadingText(false);
      }
    };
    void collectText();
    return () => {
      cancelled = true;
    };
  }, [document]);

  useEffect(() => {
    if (!query.trim() || searchRevision === 0 || !scrollRef.current) return;
    const scrollRoot = scrollRef.current;
    let observer: MutationObserver | undefined;
    let timeout = 0;
    const scrollToMatch = () => {
      const match = scrollRoot.querySelector<HTMLElement>('.search-mark');
      if (!match) return false;
      match.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      observer?.disconnect();
      window.clearTimeout(timeout);
      return true;
    };

    if (scrollToMatch()) return;
    observer = new MutationObserver(scrollToMatch);
    observer.observe(scrollRoot, { childList: true, subtree: true });
    timeout = window.setTimeout(() => observer?.disconnect(), 5000);
    return () => {
      observer?.disconnect();
      window.clearTimeout(timeout);
    };
  }, [page, query, searchRevision]);

  const handle = {
    previousPage: () => setPage((value) => Math.max(1, value - 1)),
    nextPage: () => setPage((value) => Math.min(pageCount || 1, value + 1)),
    goToPage: (value: number) => setPage(Math.min(pageCount || 1, Math.max(1, value))),
    zoom: (amount: number) => setZoom((value) => Math.min(3, Math.max(0.35, value + amount))),
    resetZoom: () => setZoom(1),
    find: (term: string, direction: 1 | -1) => {
      const normalized = term.trim().toLocaleLowerCase();
      if (!normalized || !hits.length) return;
      const matches = hits.filter((entry) => entry.text.toLocaleLowerCase().includes(normalized));
      if (!matches.length) return;
      const currentIndex = matches.findIndex((entry) => entry.page === page);
      const nextIndex = currentIndex < 0
        ? (direction > 0 ? 0 : matches.length - 1)
        : (currentIndex + direction + matches.length) % matches.length;
      setPage(matches[nextIndex].page);
      setSearchRevision((revision) => revision + 1);
    },
    setTool,
    scrollBy: (amount: number) => scrollRef.current?.scrollBy({ top: amount, behavior: 'auto' }),
    getScrollMetrics: () => ({
      top: scrollRef.current?.scrollTop ?? 0,
      maxTop: scrollRef.current
        ? Math.max(0, scrollRef.current.scrollHeight - scrollRef.current.clientHeight)
        : 0,
      page,
      pageCount,
    }),
    turnPage: (direction: 1 | -1) => {
      const nextPage = page + direction;
      if (nextPage < 1 || nextPage > pageCount) return;
      pendingPageAlignmentRef.current = direction > 0 ? 'top' : 'bottom';
      setPage(nextPage);
    },
  };

  useImperativeHandle(ref, () => handle, [pageCount, hits, page]);
  useEffect(() => register(item.id, handle), [item.id, register, pageCount, hits, page, zoom, tool]);

  const onPageChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPageInput(event.target.value);
  };

  const commitPage = () => {
    const value = Number(pageInput);
    if (Number.isFinite(value)) setPage(Math.min(pageCount, Math.max(1, value)));
    else setPageInput(String(page));
  };

  const addHighlight = () => {
    const pending = pendingHighlightRef.current;
    if (!pending || pending.page !== page) return;
    setHighlights((current) => [
      ...current,
      ...pending.rects.map((rect) => ({ ...rect, id: crypto.randomUUID() })),
    ]);
    window.getSelection()?.removeAllRanges();
    pendingHighlightRef.current = null;
    setTool('pan');
  };

  const addNote = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== 'note' || (event.target as HTMLElement).closest('.note-marker')) return;
    const pageElement = (event.target as HTMLElement).closest<HTMLElement>('.react-pdf__Page');
    if (!pageElement) return;
    const text = window.prompt('Add a note');
    if (!text?.trim()) return;
    const rect = pageElement.getBoundingClientRect();
    setNotes((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        page,
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        text: text.trim(),
      },
    ]);
    setTool('pan');
  };

  const saveAs = async () => {
    setSaving(true);
    try {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const output = await PDFDocument.load(await item.file.arrayBuffer());
      const font = await output.embedFont(StandardFonts.Helvetica);

      highlights.forEach((mark) => {
        const pdfPage = output.getPage(mark.page - 1);
        const { width, height } = pdfPage.getSize();
        pdfPage.drawRectangle({
          x: mark.x * width,
          y: height - (mark.y + mark.height) * height,
          width: mark.width * width,
          height: mark.height * height,
          color: rgb(0.96, 0.78, 0.34),
          opacity: 0.36,
        });
      });

      notes.forEach((note) => {
        const pdfPage = output.getPage(note.page - 1);
        const { width, height } = pdfPage.getSize();
        const anchorX = note.x * width;
        const anchorY = height - note.y * height;
        const cardWidth = Math.min(180, width - 16);
        const cardHeight = 48;
        const cardX = Math.max(8, Math.min(anchorX + 9, width - cardWidth - 8));
        const cardY = Math.max(8, Math.min(anchorY - cardHeight / 2, height - cardHeight - 8));
        pdfPage.drawCircle({
          x: anchorX,
          y: anchorY,
          size: 6,
          color: rgb(0.91, 0.48, 0.35),
          borderColor: rgb(1, 1, 1),
          borderWidth: 1,
        });
        pdfPage.drawRectangle({
          x: cardX,
          y: cardY,
          width: cardWidth,
          height: cardHeight,
          color: rgb(1, 0.97, 0.81),
          borderColor: rgb(0.84, 0.69, 0.38),
          borderWidth: 0.7,
        });
        pdfPage.drawText(note.text.replace(/[^\x20-\x7E]/g, '?'), {
          x: cardX + 6,
          y: cardY + cardHeight - 12,
          size: 8,
          lineHeight: 10,
          maxWidth: cardWidth - 12,
          font,
        });
      });

      const bytes = await output.save();
      const fileName = `${item.file.name.replace(/\.pdf$/i, '')}-annotated.pdf`;
      if (item.sourceFolder) {
        const destination = await item.sourceFolder.getFileHandle(fileName, { create: true });
        const writable = await destination.createWritable();
        await writable.write(bytes);
        await writable.close();
        return;
      }

      const fileSystemApi = window as unknown as {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: { description: string; accept: Record<string, string[]> }[];
        }) => Promise<WritableFileHandle>;
      };
      if (fileSystemApi.showSaveFilePicker) {
        const destination = await fileSystemApi.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
        });
        const writable = await destination.createWritable();
        await writable.write(bytes);
        await writable.close();
        return;
      }

      const url = window.URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Unable to save annotated PDF', error);
      window.alert('Could not save this PDF. The file may be encrypted or unsupported.');
    } finally {
      setSaving(false);
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== 'pan' || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    if (!scrollRef.current) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: scrollRef.current.scrollLeft,
      top: scrollRef.current.scrollTop,
      pointerType: event.pointerType,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !scrollRef.current) return;
    const scrollContainer = scrollRef.current;
    const drag = dragRef.current;
    const nextScrollTop = drag.top - (event.clientY - drag.y);
    scrollContainer.scrollLeft = drag.left - (event.clientX - drag.x);

    if (drag.pointerType === 'touch') {
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      if (nextScrollTop > maxScrollTop + 36 && page < pageCount) {
        pendingPageAlignmentRef.current = 'top';
        dragRef.current = null;
        setPage(page + 1);
        return;
      }
      if (nextScrollTop < -36 && page > 1) {
        pendingPageAlignmentRef.current = 'bottom';
        dragRef.current = null;
        setPage(page - 1);
        return;
      }
      scrollContainer.scrollTop = Math.min(maxScrollTop, Math.max(0, nextScrollTop));
      return;
    }

    scrollContainer.scrollTop = nextScrollTop;
  };

  const showHitCount = query.trim()
    ? hits.filter((entry) => entry.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length
    : 0;

  return (
    <section className="document-pane">
      <header className="pane-header">
        <div className="file-ident">
          <span className="file-glyph"><Files size={15} /></span>
          <div className="file-name-wrap">
            <strong title={item.file.name}>{item.file.name}</strong>
            <span>{pageCount ? `${pageCount} pages` : 'Loading document'}</span>
          </div>
        </div>
        <div className="pane-header-actions">
          <button className="save-button" title="Save annotated copy as PDF" onClick={() => void saveAs()} disabled={saving}>
            <Download size={14} />
            <span>{saving ? 'Saving…' : 'Save As'}</span>
          </button>
          {allowRemove && (
            <button className="icon-button pane-close" title="Close document" onClick={() => onRemove(item.id)}>
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="pane-controls">
        <button className="icon-button" title="Previous page" onClick={handle.previousPage} disabled={page <= 1}>
          <span className="chevron left" />
        </button>
        <label className="page-counter">
          <input value={pageInput} onChange={onPageChange} onBlur={commitPage} onKeyDown={(event) => event.key === 'Enter' && commitPage()} aria-label="Current page" />
          <span>/ {pageCount || '–'}</span>
        </label>
        <button className="icon-button" title="Next page" onClick={handle.nextPage} disabled={pageCount > 0 && page >= pageCount}>
          <span className="chevron right" />
        </button>
        <span className="control-divider" />
        <button className="icon-button" title="Zoom out" onClick={() => handle.zoom(-0.15)}><Minus size={15} /></button>
        <button className="zoom-label" title="Reset zoom to 100%" onClick={handle.resetZoom}>{Math.round(zoom * 100)}%</button>
        <button className="icon-button" title="Zoom in" onClick={() => handle.zoom(0.15)}><Plus size={15} /></button>
      </div>

      <div
        className={`page-scroll ${tool === 'pan' ? 'is-pannable' : ''} ${tool === 'text' ? 'is-text-selecting' : ''} ${tool === 'note' ? 'is-noting' : ''}`}
        ref={scrollRef}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}
        onClick={addNote}
      >
        <Document
          file={item.file}
          loading={<div className="empty-document">Opening PDF…</div>}
          error={<div className="empty-document error-message">This PDF could not be opened.</div>}
          onLoadSuccess={(pdf) => {
            setDocument(pdf);
            setPageCount(pdf.numPages);
            setPage((current) => Math.min(current, pdf.numPages));
            setPageInput((current) => String(Math.min(Number(current) || 1, pdf.numPages)));
          }}
        >
          {pageCount > 0 && (
            <div className="page-shell" data-page={page}>
              <Page
                pageNumber={page}
                scale={zoom}
                renderTextLayer
                renderAnnotationLayer
                customTextRenderer={({ str }) => highlightText(str, query)}
                loading={<div className="empty-document">Rendering page…</div>}
              />
              <div className="mark-layer" aria-hidden="true">
                {highlights.filter((mark) => mark.page === page).map((mark) => (
                  <span key={mark.id} className="saved-highlight" style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, width: `${mark.width * 100}%`, height: `${mark.height * 100}%` }} />
                ))}
                {notes.filter((note) => note.page === page).map((note) => (
                  <button
                    key={note.id}
                    className="note-marker"
                    style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
                    title={note.text}
                    aria-label={`Note: ${note.text}`}
                    onClick={(event) => { event.stopPropagation(); window.alert(note.text); }}
                  ><MessageSquareText size={13} /></button>
                ))}
              </div>
            </div>
          )}
        </Document>
      </div>

      <footer className="pane-footer">
        <div className="tool-group" aria-label="Document tools">
          <button className={`tool-button ${tool === 'pan' ? 'active' : ''}`} title="Pan and select" onClick={() => setTool('pan')}><MousePointer2 size={15} /></button>
          <button className={`tool-button ${tool === 'text' ? 'active' : ''}`} title="Select text" aria-label="Select text" aria-pressed={tool === 'text'} onClick={() => setTool('text')}><TextSelect size={15} /></button>
          <button className="tool-button" title="Highlight selected text" aria-label="Highlight selected text" onClick={addHighlight} disabled={tool !== 'text'}><Highlighter size={15} /></button>
          <button className={`tool-button ${tool === 'note' ? 'active' : ''}`} title="Add note to page" onClick={() => setTool('note')}><StickyNote size={15} /></button>
        </div>
        <span className="hit-status">
          {loadingText ? 'Indexing text…' : query ? `${showHitCount} page${showHitCount === 1 ? '' : 's'} found` : ' '}
        </span>
      </footer>
    </section>
  );
});

function App() {
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [layout, setLayout] = useState<1 | 2 | 4>(1);
  const [query, setQuery] = useState('');
  const paneHandles = useRef(new Map<string, PaneHandle>());
  const fileInput = useRef<HTMLInputElement>(null);
  const syncDrag = useRef<{ y: number; pointerType: string; overscroll: number } | null>(null);

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    setFiles((current) => [
      ...current,
      ...selected.map((file) => ({ id: crypto.randomUUID(), file })),
    ].slice(0, 4));
    event.target.value = '';
  };

  const openFolder = async () => {
    const fileSystemApi = window as unknown as {
      showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<SourceFolderHandle>;
    };
    if (!fileSystemApi.showDirectoryPicker) {
      window.alert('Folder access is not supported in this browser. Use Add PDFs and choose a save location when saving.');
      return;
    }
    try {
      const folder = await fileSystemApi.showDirectoryPicker({ mode: 'readwrite' });
      const folderFiles: PdfFile[] = [];
      for await (const entry of folder.values() as unknown as AsyncIterable<FolderEntry>) {
        if (entry.kind !== 'file' || !/\.pdf$/i.test(entry.name) || !entry.getFile) continue;
        folderFiles.push({ id: crypto.randomUUID(), file: await entry.getFile(), sourceFolder: folder });
      }
      folderFiles.sort((first, second) => first.file.name.localeCompare(second.file.name));
      setFiles(folderFiles.slice(0, 4));
      setLayout(folderFiles.length >= 4 ? 4 : folderFiles.length >= 2 ? 2 : 1);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Unable to open PDF folder', error);
      window.alert('Could not read PDFs from that folder.');
    }
  };

  const removeFile = (id: string) => {
    paneHandles.current.delete(id);
    setFiles((current) => current.filter((entry) => entry.id !== id));
  };

  const register = (id: string, handle: PaneHandle | null) => {
    if (handle) paneHandles.current.set(id, handle);
    else paneHandles.current.delete(id);
  };

  const runSearch = (direction: 1 | -1) => {
    paneHandles.current.forEach((handle) => handle.find(query, direction));
  };

  const applyToPanes = (action: (handle: PaneHandle) => void) => {
    paneHandles.current.forEach(action);
  };

  const startSyncDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    syncDrag.current = { y: event.clientY, pointerType: event.pointerType, overscroll: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveSyncDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = syncDrag.current;
    if (!drag) return;
    const delta = drag.y - event.clientY;
    drag.y = event.clientY;
    if (!delta) return;

    const panes = Array.from(paneHandles.current.values());
    const before = panes.map((pane) => pane.getScrollMetrics());
    panes.forEach((pane) => pane.scrollBy(delta));

    if (drag.pointerType !== 'touch' || panes.length !== 2) return;
    const overscroll = delta > 0
      ? Math.min(...before.map((metrics) => Math.max(0, metrics.top + delta - metrics.maxTop)))
      : Math.min(...before.map((metrics) => Math.max(0, -(metrics.top + delta))));
    if (overscroll === 0) {
      drag.overscroll = 0;
      return;
    }

    drag.overscroll += overscroll;
    if (drag.overscroll < 36) return;
    const direction = delta > 0 ? 1 : -1;
    const canTurnBoth = before.every((metrics) =>
      direction > 0 ? metrics.page < metrics.pageCount : metrics.page > 1,
    );
    if (canTurnBoth) panes.forEach((pane) => pane.turnPage(direction));
    drag.overscroll = 0;
  };

  const finishSyncDrag = () => {
    syncDrag.current = null;
  };

  const changeLayout = (next: 1 | 2 | 4) => {
    setLayout(next);
    if (next === 2 && files.length < 2) fileInput.current?.click();
    if (next === 4 && files.length < 4) fileInput.current?.click();
  };

  const visibleFiles = files.slice(0, layout);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Folio home">
          <span className="brand-mark"><Files size={17} /></span>
          <span>folio<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-center">
          <div className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && runSearch(1)}
              placeholder="Find in documents"
              aria-label="Search PDF text"
            />
            {query && <button title="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
          </div>
          <button className="search-nav" title="Previous search result" onClick={() => runSearch(-1)} disabled={!query}><span className="chevron up" /></button>
          <button className="search-nav" title="Next search result" onClick={() => runSearch(1)} disabled={!query}><span className="chevron down" /></button>
        </div>
        <div className="topbar-actions">
          <div className="layout-switch" aria-label="Viewer layout">
            <button className={layout === 1 ? 'selected' : ''} title="Single document" onClick={() => changeLayout(1)}><Maximize size={15} /></button>
            <button className={layout === 2 ? 'selected' : ''} title="Compare two documents" onClick={() => changeLayout(2)}><span className="layout-two" /></button>
            <button className={layout === 4 ? 'selected' : ''} title="Tile four documents" onClick={() => changeLayout(4)}><span className="layout-four" /></button>
          </div>
          <button className="primary-button" onClick={() => fileInput.current?.click()}><FilePlus2 size={16} /><span>Add PDFs</span></button>
          <button className="folder-button" title="Open PDFs from a folder for same-folder saves" onClick={() => void openFolder()}><FolderOpen size={16} /><span>Open folder</span></button>
          <input ref={fileInput} className="hidden-input" type="file" accept="application/pdf,.pdf" multiple onChange={addFiles} />
        </div>
      </header>

      <div className="workspace">
        {visibleFiles.length ? (
          <div className={`pane-grid layout-${layout}`}>
            {visibleFiles.map((item) => (
              <PdfPane
                key={item.id}
                ref={(handle) => register(item.id, handle)}
                item={item}
                query={query}
                register={register}
                onRemove={removeFile}
                allowRemove={files.length > 1}
              />
            ))}
            {layout === 2 && visibleFiles.length === 2 && (
              <button
                className="sync-scroll-handle"
                title="Drag up or down to scroll both documents"
                aria-label="Drag to scroll both documents"
                onPointerDown={startSyncDrag}
                onPointerMove={moveSyncDrag}
                onPointerUp={finishSyncDrag}
                onPointerCancel={finishSyncDrag}
              ><GripVertical size={17} /></button>
            )}
            {visibleFiles.length < layout && (
              <button className="add-pane" onClick={() => fileInput.current?.click()}>
                <span><FilePlus2 size={20} /></span>
                <strong>Add another PDF</strong>
                <small>Compare documents in this workspace</small>
              </button>
            )}
          </div>
        ) : (
          <section className="welcome-state">
            <div className="welcome-art" aria-hidden="true">
              <div className="paper paper-back"><i /><i /><i /></div>
              <div className="paper paper-front"><span>PDF</span><i /><i /><i /><b /></div>
              <div className="welcome-highlight" />
            </div>
            <p className="eyebrow">A quieter place to read</p>
            <h1>Bring your documents<br />into focus.</h1>
            <p className="welcome-copy">Open a PDF to read, search, compare, and annotate in one workspace.</p>
            <button className="primary-button welcome-button" onClick={() => fileInput.current?.click()}><FilePlus2 size={17} />Open a PDF</button>
            <p className="file-note">PDF files stay in your browser</p>
          </section>
        )}
      </div>

      {files.length > 0 && (
        <div className="global-tools">
          <span className="global-label">Workspace</span>
          <span className="global-separator" />
          <button onClick={() => applyToPanes((pane) => pane.previousPage())} title="Previous page in all documents"><span className="chevron left" />Previous</button>
          <button onClick={() => applyToPanes((pane) => pane.nextPage())} title="Next page in all documents">Next<span className="chevron right" /></button>
          <span className="global-separator" />
          <button onClick={() => applyToPanes((pane) => pane.resetZoom())} title="Reset all documents to 100%">100%</button>
          <button onClick={() => applyToPanes((pane) => pane.zoom(0.15))} title="Zoom in on all documents"><Plus size={14} /></button>
          <button onClick={() => applyToPanes((pane) => pane.zoom(-0.15))} title="Zoom out on all documents"><Minus size={14} /></button>
          <span className="global-separator" />
          <button onClick={() => applyToPanes((pane) => pane.setTool('text'))}><TextSelect size={14} />Select text</button>
          <button onClick={() => applyToPanes((pane) => pane.setTool('note'))}><StickyNote size={14} />Note</button>
        </div>
      )}
    </main>
  );
}

export default App;
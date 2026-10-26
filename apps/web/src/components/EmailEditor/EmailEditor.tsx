/* eslint-disable @typescript-eslint/no-explicit-any */
import {EditorContent, useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Color} from '@tiptap/extension-color';
import {TextStyle} from '@tiptap/extension-text-style';
import {Link} from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import {Variable} from './VariableExtension';
import {setAvailableVariables, VariableMention} from './VariableMention';
import {LogicMention} from './LogicMention';
import {subscribeSuggestionOpen} from './suggestionPopup';
import {Toolbar} from './Toolbar';
import {ResizableImage} from './ResizableImage';
import {type ButtonAttrs, EmailButton} from './EmailButton';
import {ButtonDialog} from './ButtonDialog';
import {BoxDialog, useBoxDialog} from './BoxDialog';
import {EmailBox, EmailDocument} from './EmailBox';
import {ImageDialog} from './ImageDialog';
import {type DividerAttrs, EmailDivider} from './EmailDivider';
import {DividerDialog} from './DividerDialog';
import {EmailSpacer, type SpacerAttrs} from './EmailSpacer';
import {EmailVideo, type VideoAttrs} from './EmailVideo';
import {SlashCommand} from './SlashCommand';
import {SpacerDialog} from './SpacerDialog';
import {VideoDialog} from './VideoDialog';
import {useBlockDialog} from './useBlockDialog';
import {EmailTextAlign} from './EmailTextAlign';
import {HtmlEditor} from './HtmlEditor';
import {PreheaderField} from './PreheaderField';
import {brandOnChange, canvasStyle, editorAttributes, useEmailBrand} from './useEmailBrand';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useContactFields, useContacts, useSegmentContacts} from '../../lib/hooks/useContacts';
import {useConfig} from '../../lib/hooks/useConfig';
import {useTemplateFieldWarnings, useTemplateValidation} from '../../lib/hooks/useTemplateValidation';
import {useEffect, useRef, useState} from 'react';
import {
  BUTTON_DEFAULTS,
  detectCustomHtmlPatterns,
  isFramedBrand,
  joinEmailMarkers,
  renderTemplate,
  splitEmailMarkers,
} from '@plunk/shared';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@plunk/ui';
import {AlertTriangle, Code2, Eye, Monitor, Smartphone, Tablet} from 'lucide-react';
import {wrapEmailWithStyles} from '../../lib/emailStyles';
import 'tippy.js/dist/tippy.css';

interface EmailEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // Optional props for preview header
  subject?: string;
  from?: string;
  replyTo?: string;
  // When set, the "Preview as" dropdown is scoped to this segment's members
  // instead of all contacts in the project (used for SEGMENT-audience campaigns)
  segmentId?: string;
}

const commonVariables = [
  {name: 'id', description: 'Contact ID'},
  {name: 'email', description: 'Recipient email address'},
  {name: 'unsubscribeUrl', description: 'Unsubscribe link'},
  {name: 'subscribeUrl', description: 'Subscribe link'},
  {name: 'manageUrl', description: 'Manage link'},
];

export function EmailEditor({value, onChange, placeholder, subject, from, replyTo, segmentId}: EmailEditorProps) {
  // The preview text and the brand travel with the body; the editors below only ever see the body
  const {preheader, brand, body} = splitEmailMarkers(value);
  const {activeProject} = useActiveProject();
  const emailBrand = useEmailBrand(activeProject?.id, brand, body);
  const markersRef = useRef({preheader, brand, body, project: emailBrand.project});
  markersRef.current = {preheader, brand, body, project: emailBrand.project};
  // A change keeps the email's brand, or gives an email that was empty the project's
  const withMarkers = (html: string, nextPreheader?: string) => {
    const current = markersRef.current;
    return joinEmailMarkers({
      preheader: nextPreheader ?? current.preheader,
      brand: brandOnChange(current.brand, current.body, current.project),
      body: html,
    });
  };
  const emitChange = (html: string) => onChange(withMarkers(html));
  const canvas = canvasStyle(emailBrand.look);

  // Detect if initial value has custom HTML and start in appropriate mode
  const initialMode = detectCustomHtmlPatterns(body) ? 'html' : 'visual';

  const [mode, setMode] = useState<'visual' | 'html'>(initialMode);
  const [htmlContent, setHtmlContent] = useState(body);
  const [showVariableDialog, setShowVariableDialog] = useState(false);
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [showModeWarningDialog, setShowModeWarningDialog] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [customVariable, setCustomVariable] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [previewUpdateTrigger, setPreviewUpdateTrigger] = useState(0);

  // Fetch available contact fields using SWR
  const {fields: availableFields, fieldDetails} = useContactFields();

  // Surface Liquid syntax errors while editing. Saving rejects an unparseable template
  // anyway, so the alternative is learning about a typo from a 400 after the fact.
  const syntaxIssue = useTemplateValidation(htmlContent);

  // Fields that parse but resolve to nothing: a typo, or a field so few contacts carry
  // that the template is blank for most of the audience. Only shown once the template
  // parses — a broken template makes every reference in it suspect.
  const fieldWarnings = useTemplateFieldWarnings(htmlContent, fieldDetails);

  // A trigger being completed (`{%ema` with its menu open) is not valid Liquid yet.
  // Reporting that as an error would contradict the menu offering to finish it.
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  useEffect(() => subscribeSuggestionOpen(setSuggestionOpen), []);

  // Fetch contacts for preview using SWR.
  // When the campaign targets a segment, scope the dropdown to that segment's
  // members; otherwise fall back to all contacts in the project.
  const {contacts: allContacts} = useContacts({limit: 50});
  const {contacts: segmentContacts} = useSegmentContacts(segmentId);
  const contacts = segmentId ? segmentContacts : allContacts;

  useEffect(() => {
    if (fieldDetails.length > 0) {
      setAvailableVariables(fieldDetails);
    }
  }, [fieldDetails]);

  // Clear the preview selection when the chosen contact is no longer in the
  // available list (e.g. the segment changed). Otherwise the preview stays
  // stuck rendering a contact that's no longer selectable in the dropdown.
  useEffect(() => {
    if (selectedContactId && !contacts.some(c => c.id === selectedContactId)) {
      setSelectedContactId('');
    }
  }, [contacts, selectedContactId]);

  const {data: config} = useConfig();
  const canUploadImages = Boolean(config?.features.storage.s3Enabled);
  // Read by the slash menu as it updates, so it follows the config once loaded
  const canUploadImagesRef = useRef(canUploadImages);
  canUploadImagesRef.current = canUploadImages;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // Boxes go at the top of the document, beside blocks (see EmailBox)
        document: false,
        heading: {
          levels: [1, 2, 3],
        },
      }),
      EmailDocument,
      EmailTextAlign,
      Color,
      TextStyle,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
        },
      }),
      ResizableImage,
      EmailButton,
      EmailDivider,
      EmailSpacer,
      EmailVideo,
      EmailBox,
      Variable,
      VariableMention,
      LogicMention,
      SlashCommand.configure({canInsertImages: () => canUploadImagesRef.current}),
      Placeholder.configure({
        // On the empty line the cursor is in, where the slash menu would open
        placeholder: ({editor, node}) =>
          node.type.name !== 'paragraph'
            ? ''
            : editor.isEmpty
              ? `${placeholder || 'Your next email starts here'}. Type / for blocks`
              : 'Type / for blocks',
      }),
    ],
    // Only initialize with content if starting in visual mode
    // If starting in HTML mode (due to custom HTML), keep editor empty
    content: initialMode === 'visual' ? body || '' : '',
    editorProps: {
      // In the email's brand; useEditor applies these again whenever they change
      attributes: editorAttributes(emailBrand.look),
    },
    onUpdate: ({editor}) => {
      const html = editor.getHTML();
      emitChange(html);
      setHtmlContent(html);
      // Trigger preview update
      setPreviewUpdateTrigger(prev => prev + 1);
    },
  });

  const button = useBlockDialog<ButtonAttrs>(editor, 'button');

  const divider = useBlockDialog<DividerAttrs>(editor, 'horizontalRule', true);
  const spacer = useBlockDialog<SpacerAttrs>(editor, 'spacer', true);
  const video = useBlockDialog<VideoAttrs>(editor, 'video');
  const box = useBoxDialog(editor, emailBrand.look);

  // The slash menu's image row opens the same dialog as the toolbar
  useEffect(() => {
    if (!editor) return;
    const add = ({type}: {type: string}) => {
      if (type === 'image') setShowImageDialog(true);
    };
    editor.on('newBlock', add);
    return () => {
      editor.off('newBlock', add);
    };
  }, [editor]);

  // Update editor content when value prop changes from outside
  useEffect(() => {
    if (editor && body !== editor.getHTML() && body !== htmlContent) {
      // Only update editor if in visual mode or if value is simple HTML
      const isCustomHtml = detectCustomHtmlPatterns(body);

      if (!isCustomHtml && mode === 'visual') {
        editor.commands.setContent(body || '');
      }

      // Always update htmlContent to stay in sync
      setHtmlContent(body);

      // If custom HTML is detected and we're in visual mode, switch to HTML mode
      if (isCustomHtml && mode === 'visual') {
        setMode('html');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  // Use the same pattern detection as initialization (no editor manipulation)
  const detectCustomHtml = (html: string): boolean => {
    return detectCustomHtmlPatterns(html);
  };

  const handleModeToggle = () => {
    if (mode === 'visual') {
      // Switching to HTML mode
      const currentHtml = editor?.getHTML() || '';
      setHtmlContent(currentHtml);
      setMode('html');
    } else {
      // Switching to visual mode - check if custom HTML will be lost
      if (detectCustomHtml(htmlContent)) {
        setShowModeWarningDialog(true);
      } else {
        switchToVisualMode();
      }
    }
  };

  const switchToVisualMode = () => {
    // Only switch if we have an editor and html content
    if (editor) {
      editor.commands.setContent(htmlContent || '');
      emitChange(htmlContent);
      setMode('visual');
    }
    setShowModeWarningDialog(false);
  };

  const handleHtmlChange = (newHtml: string) => {
    setHtmlContent(newHtml);
    emitChange(newHtml);
  };

  const insertVariable = (varName: string, withDefault?: boolean) => {
    if (editor) {
      // Insert the variable placeholder as text with optional default value
      const variableText = withDefault && defaultValue ? `{{${varName} ?? ${defaultValue}}}` : `{{${varName}}}`;
      editor.chain().focus().insertContent(variableText).run();
      setShowVariableDialog(false);
      setCustomVariable('');
      setDefaultValue('');
    }
  };

  const replaceVariables = (text: string, contactData: Record<string, unknown>) => {
    return renderTemplate(text, contactData);
  };

  const getPreviewHtml = () => {
    const currentHtml = mode === 'visual' ? editor?.getHTML() || '' : htmlContent;
    if (!selectedContactId) return currentHtml;

    const contact = contacts.find(c => c.id === selectedContactId);
    if (!contact) return currentHtml;

    const contactData = {
      email: contact.email,
      unsubscribed: (contact as {subscribed?: boolean}).subscribed ? 'No' : 'Yes',
      unsubscribeUrl: `${window.location.origin}/unsubscribe/${contact.id}`,
      subscribeUrl: `${window.location.origin}/subscribe/${contact.id}`,
      manageUrl: `${window.location.origin}/manage/${contact.id}`,
      data: contact.data || {},
      ...((contact.data as Record<string, unknown> | null) || {}),
    };

    return replaceVariables(currentHtml, contactData);
  };

  const getPreviewSubject = () => {
    if (!subject || !selectedContactId) return subject || '';

    const contact = contacts.find(c => c.id === selectedContactId);
    if (!contact) return subject;

    const contactData = {
      email: contact.email,
      unsubscribed: (contact as {subscribed?: boolean}).subscribed ? 'No' : 'Yes',
      unsubscribeUrl: `${window.location.origin}/unsubscribe/${contact.id}`,
      subscribeUrl: `${window.location.origin}/subscribe/${contact.id}`,
      manageUrl: `${window.location.origin}/manage/${contact.id}`,
      data: contact.data || {},
      ...((contact.data as Record<string, unknown> | null) || {}),
    };

    return replaceVariables(subject, contactData);
  };

  const getPreviewContainerWidth = () => {
    // Return the actual width the iframe should have (for media queries)
    switch (previewDevice) {
      case 'mobile':
        return '375px';
      case 'tablet':
        return '768px';
      case 'desktop':
      default:
        return '1200px'; // Standard desktop email width
    }
  };

  // Ref for the preview iframe
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // Update iframe content when preview changes
  useEffect(() => {
    if (previewIframeRef.current && selectedContactId) {
      const iframe = previewIframeRef.current;
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;

      if (iframeDoc) {
        const previewContent = getPreviewHtml();
        const fullHtml = wrapEmailWithStyles(previewContent, emailBrand.look);

        iframeDoc.open();
        iframeDoc.write(fullHtml);
        iframeDoc.close();

        // Auto-adjust iframe height to content. Reset to a small value first so
        // body content that uses % / vh heights doesn't lock the iframe to its
        // previous size (which would otherwise cause the iframe to grow by the
        // padding offset on every preview-device switch).
        const adjustHeight = () => {
          if (!iframe.contentWindow) return;
          iframe.style.height = '0px';
          const doc = iframe.contentWindow.document;
          const height = Math.max(
            doc.body?.scrollHeight ?? 0,
            doc.documentElement?.scrollHeight ?? 0,
          );
          iframe.style.height = `${Math.max(400, height + 40)}px`;
        };

        const timeouts = [
          window.setTimeout(adjustHeight, 100),
          window.setTimeout(adjustHeight, 300),
        ];
        iframe.contentWindow?.addEventListener('load', adjustHeight);

        return () => {
          timeouts.forEach(window.clearTimeout);
          iframe.contentWindow?.removeEventListener('load', adjustHeight);
        };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContactId, htmlContent, mode, previewDevice, previewUpdateTrigger, JSON.stringify(emailBrand.look)]);

  return (
    <div className="border border-neutral-200 rounded-lg bg-white">
      {/* Mode toggle */}
      <div className="border-b border-neutral-200 bg-neutral-50 p-2 flex flex-col sm:flex-row justify-between sm:items-center gap-2">
        <div className="flex gap-1">
          <Button
            type="button"
            variant={mode === 'visual' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => mode === 'html' && handleModeToggle()}
          >
            <Eye className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Visual</span>
          </Button>
          <Button
            type="button"
            variant={mode === 'html' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => mode === 'visual' && handleModeToggle()}
          >
            <Code2 className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">HTML</span>
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-1 sm:flex-none">
          <Label htmlFor="preview-contact" className="text-xs text-neutral-600 whitespace-nowrap">
            Preview as:
          </Label>
          <Select
            value={selectedContactId || 'none'}
            onValueChange={val => setSelectedContactId(val === 'none' ? '' : val)}
          >
            <SelectTrigger id="preview-contact" className="h-8 w-full sm:w-[200px] text-xs">
              <SelectValue placeholder="Select contact…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                <span className="text-neutral-500">No preview</span>
              </SelectItem>
              {contacts.map(contact => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contact.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <PreheaderField value={preheader} onChange={next => onChange(withMarkers(body, next))} />

      {mode === 'visual' && emailBrand.differs && (
        <div className="flex items-center justify-between gap-3 border-t border-sky-200 bg-sky-50 px-4 py-2">
          <p className="text-xs text-sky-900">This email uses different styles from the project&apos;s brand.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => onChange(joinEmailMarkers({preheader, brand: emailBrand.project, body}))}
          >
            Apply brand
          </Button>
        </div>
      )}

      {/* Template syntax errors, reported as you type rather than on save */}
      {syntaxIssue && !suggestionOpen && (
        <div className="flex items-start gap-2 border-t border-red-200 bg-red-50 px-4 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-red-800">{syntaxIssue.message}</p>
            {syntaxIssue.excerpt && (
              <code className="block truncate rounded border border-red-200 bg-white px-1.5 py-0.5 font-mono text-xs text-red-900">
                {syntaxIssue.excerpt}
              </code>
            )}
            <p className="text-[11px] text-red-700">
              {/* Line numbers only exist in the HTML editor's gutter. */}
              {mode === 'html' && syntaxIssue.line !== undefined
                ? `Line ${syntaxIssue.line}, column ${syntaxIssue.column} — saving will fail until this is fixed.`
                : 'Saving will fail until this is fixed.'}
            </p>
          </div>
        </div>
      )}

      {/* Field references that parse but will not resolve */}
      {!syntaxIssue && !suggestionOpen && fieldWarnings.length > 0 && (
        <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <div className="min-w-0 space-y-1">
            {fieldWarnings.map(warning => (
              <p key={warning.field} className="text-xs text-amber-900">
                {warning.message}
              </p>
            ))}
            <p className="text-[11px] text-amber-700">This still sends. Nothing here blocks saving.</p>
          </div>
        </div>
      )}

      {/* Editor content */}
      {mode === 'visual' ? (
        <>
          <Toolbar
            editor={editor}
            onInsertVariable={() => setShowVariableDialog(true)}
            onInsertImage={() => setShowImageDialog(true)}
            onButton={button.onToolbar}
            onDivider={divider.onToolbar}
            onSpacer={spacer.onToolbar}
            onVideo={video.onToolbar}
            onBox={box.onToolbar}
            canUploadImages={canUploadImages}
          />
          <div className="min-h-[400px] max-h-[600px] overflow-y-auto" style={canvas.outer}>
            <div style={canvas.inner} data-framed={isFramedBrand(emailBrand.look) ? '' : undefined}>
              <EditorContent editor={editor} />
            </div>
          </div>
          {selectedContactId && (
            <>
              <div className="border-t border-neutral-200 bg-neutral-100 px-4 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-neutral-600">Preview</p>
                    <span className="text-xs text-neutral-500">
                      ({previewDevice === 'mobile' ? '375px' : previewDevice === 'tablet' ? '768px' : '1200px'})
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant={previewDevice === 'mobile' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('mobile')}
                      className="h-7 w-7 p-0"
                      title="Mobile (375px)"
                    >
                      <Smartphone className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={previewDevice === 'tablet' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('tablet')}
                      className="h-7 w-7 p-0"
                      title="Tablet (768px)"
                    >
                      <Tablet className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={previewDevice === 'desktop' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('desktop')}
                      className="h-7 w-7 p-0"
                      title="Desktop (1200px)"
                    >
                      <Monitor className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-4 bg-neutral-50 flex justify-center items-start overflow-auto min-h-[400px]">
                <div
                  className="transition-all duration-300"
                  style={{
                    width: getPreviewContainerWidth(),
                    maxWidth: '100%',
                  }}
                >
                  <div className="bg-white rounded-lg border border-neutral-300 shadow-lg overflow-hidden">
                    {/* Email Header Preview */}
                    {(subject || from || replyTo) && (
                      <div className="bg-neutral-50 border-b border-neutral-200 p-4 space-y-2">
                        {subject && (
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-xs text-neutral-500 uppercase tracking-wide font-medium">Subject</p>
                              <p className="text-base font-semibold text-neutral-900 mt-1">{getPreviewSubject()}</p>
                            </div>
                          </div>
                        )}
                        {(from || replyTo) && (
                          <div className="flex gap-6 pt-2 border-t border-neutral-200">
                            {from && (
                              <div>
                                <p className="text-xs text-neutral-500">From</p>
                                <p className="text-sm text-neutral-900 mt-0.5">{from}</p>
                              </div>
                            )}
                            {replyTo && (
                              <div>
                                <p className="text-xs text-neutral-500">Reply-To</p>
                                <p className="text-sm text-neutral-900 mt-0.5">{replyTo}</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <iframe
                      ref={previewIframeRef}
                      className="w-full border-0"
                      style={{
                        minHeight: '400px',
                        height: '100%',
                      }}
                      title="Email preview"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="min-h-[400px] max-h-[600px] overflow-hidden">
            <HtmlEditor
              value={htmlContent}
              onChange={handleHtmlChange}
              placeholder={placeholder || 'Your next email starts here'}
            />
          </div>
          {selectedContactId && (
            <>
              <div className="border-t border-neutral-200 bg-neutral-100 px-4 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-neutral-600">Preview</p>
                    <span className="text-xs text-neutral-500">
                      ({previewDevice === 'mobile' ? '375px' : previewDevice === 'tablet' ? '768px' : '1200px'})
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant={previewDevice === 'mobile' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('mobile')}
                      className="h-7 w-7 p-0"
                      title="Mobile (375px)"
                    >
                      <Smartphone className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={previewDevice === 'tablet' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('tablet')}
                      className="h-7 w-7 p-0"
                      title="Tablet (768px)"
                    >
                      <Tablet className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={previewDevice === 'desktop' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setPreviewDevice('desktop')}
                      className="h-7 w-7 p-0"
                      title="Desktop (1200px)"
                    >
                      <Monitor className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-4 bg-neutral-50 flex justify-center items-start overflow-auto min-h-[400px]">
                <div
                  className="transition-all duration-300"
                  style={{
                    width: getPreviewContainerWidth(),
                    maxWidth: '100%',
                  }}
                >
                  <div className="bg-white rounded-lg border border-neutral-300 shadow-lg overflow-hidden">
                    {/* Email Header Preview */}
                    {(subject || from || replyTo) && (
                      <div className="bg-neutral-50 border-b border-neutral-200 p-4 space-y-2">
                        {subject && (
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-xs text-neutral-500 uppercase tracking-wide font-medium">Subject</p>
                              <p className="text-base font-semibold text-neutral-900 mt-1">{getPreviewSubject()}</p>
                            </div>
                          </div>
                        )}
                        {(from || replyTo) && (
                          <div className="flex gap-6 pt-2 border-t border-neutral-200">
                            {from && (
                              <div>
                                <p className="text-xs text-neutral-500">From</p>
                                <p className="text-sm text-neutral-900 mt-0.5">{from}</p>
                              </div>
                            )}
                            {replyTo && (
                              <div>
                                <p className="text-xs text-neutral-500">Reply-To</p>
                                <p className="text-sm text-neutral-900 mt-0.5">{replyTo}</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <iframe
                      ref={previewIframeRef}
                      className="w-full border-0"
                      style={{
                        minHeight: '400px',
                        height: '100%',
                      }}
                      title="Email preview"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Variable insertion dialog */}
      <Dialog open={showVariableDialog} onOpenChange={setShowVariableDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Insert variable</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium mb-2 block">Common variables</Label>
              <div className="grid grid-cols-2 gap-2">
                {commonVariables.map(v => (
                  <Button
                    key={v.name}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => insertVariable(v.name)}
                    className="justify-start"
                  >
                    <code className="text-xs">{`{{${v.name}}}`}</code>
                  </Button>
                ))}
              </div>
            </div>

            {availableFields.length > 0 && (
              <div>
                <Label className="text-sm font-medium mb-2 block">Contact fields</Label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {availableFields
                    .filter(field => !commonVariables.some(v => v.name === field))
                    .map(field => (
                      <Button
                        key={field}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => insertVariable(field)}
                        className="justify-start"
                      >
                        <code className="text-xs">{`{{${field}}}`}</code>
                      </Button>
                    ))}
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="custom-var" className="text-sm font-medium mb-2 block">
                Custom variable
              </Label>
              <div className="space-y-2">
                <Input
                  id="custom-var"
                  value={customVariable}
                  onChange={e => setCustomVariable(e.target.value)}
                  placeholder="Variable name (e.g., firstName)"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && customVariable) {
                      insertVariable(customVariable, true);
                    }
                  }}
                />
                <Input
                  id="default-value"
                  value={defaultValue}
                  onChange={e => setDefaultValue(e.target.value)}
                  placeholder="Default value (optional, e.g., Friend)"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && customVariable) {
                      insertVariable(customVariable, true);
                    }
                  }}
                />
                <Button
                  type="button"
                  onClick={() => customVariable && insertVariable(customVariable, true)}
                  disabled={!customVariable}
                  className="w-full"
                >
                  Insert variable
                </Button>
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                Variables are replaced with actual values when sent. Use{' '}
                <code className="text-xs bg-neutral-100 px-1 rounded">{'{{name ?? default}}'}</code> syntax for fallback
                values.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showModeWarningDialog}
        onOpenChange={setShowModeWarningDialog}
        onConfirm={switchToVisualMode}
        title="Switch to the visual editor?"
        description="The visual editor may strip or rewrite parts of your HTML, such as:"
        details={
          <ul className="list-disc space-y-1 rounded-lg border border-neutral-200 py-2.5 pl-8 pr-3 text-sm text-neutral-600 marker:text-neutral-300">
            <li>Custom HTML elements and attributes</li>
            <li>Inline styles and CSS classes</li>
            <li>Complex table structures</li>
            <li>Custom formatting or layout</li>
          </ul>
        }
        icon={AlertTriangle}
        cancelText="Stay in HTML"
        confirmText="Switch anyway"
        variant="destructive"
      />

      <ButtonDialog {...button.dialogProps} defaultStyle={emailBrand.button} />
      <DividerDialog {...divider.dialogProps} />
      <SpacerDialog {...spacer.dialogProps} />
      <VideoDialog {...video.dialogProps} />
      <BoxDialog
        {...box.dialogProps}
        buttonColor={emailBrand.button?.backgroundColor ?? BUTTON_DEFAULTS.backgroundColor}
      />

      <ImageDialog
        open={showImageDialog}
        onOpenChange={setShowImageDialog}
        canUpload={canUploadImages}
        onInsert={src => (editor?.chain().focus() as any).setImage({src}).run()}
      />

      {/* Custom styles for editor */}
      <style jsx global>{`
        .variable-highlight {
          background-color: #dbeafe;
          color: #1e40af;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'Courier New', monospace;
          font-size: 14px;
        }

        .variable-placeholder {
          display: inline;
          background-color: #dbeafe;
          color: #1e40af;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'Courier New', monospace;
          font-size: 14px;
        }

        /*
         * Logic tags are structure, not data, so they read as a different kind of thing
         * from the blue value chips above rather than as a second accent colour.
         * Decoration-only: these never appear in the sent email, where the tag has
         * already been rendered away.
         */
        .logic-highlight {
          background-color: #f5f5f5;
          color: #171717;
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid #e5e5e5;
          font-family: 'Courier New', monospace;
          font-size: 13px;
        }

        .ProseMirror table {
          border-collapse: collapse;
          width: 100%;
          margin: 16px 0;
        }

        .ProseMirror th,
        .ProseMirror td {
          border: 1px solid #e5e7eb;
          padding: 8px 12px;
          text-align: left;
          min-width: 100px;
        }

        .ProseMirror th {
          background-color: #f3f4f6;
          font-weight: 600;
        }

        .ProseMirror .selectedCell {
          background-color: #e0e7ff;
        }

        .ProseMirror img {
          max-width: 100%;
          height: auto;
          display: block;
          margin: 16px 0;
        }

        /* Resizable image styles */
        .resizable-image-wrapper {
          display: block;
          margin: 16px 0;
        }

        /* Boxes: their text colour for what the prose styles colour, as when sending */
        .ProseMirror [data-box] h1,
        .ProseMirror [data-box] h2,
        .ProseMirror [data-box] h3,
        .ProseMirror [data-box] strong,
        .ProseMirror [data-box] code,
        .ProseMirror [data-box] blockquote {
          color: inherit;
        }
        .ProseMirror [data-box] blockquote {
          border-left-color: currentColor;
        }
        .ProseMirror [data-box] [data-node-view-content] > :first-child {
          margin-top: 0;
        }
        .ProseMirror [data-box] [data-node-view-content] > :last-child {
          margin-bottom: 0;
        }
        /* In a framed column, full width reaches past the editor's own side padding (px-4) */
        [data-framed] .ProseMirror [data-box-full] {
          margin-left: -1rem !important;
          margin-right: -1rem !important;
        }
        .ProseMirror [data-box] .box-settings {
          opacity: 0.4;
        }
        .ProseMirror [data-box]:hover .box-settings,
        .ProseMirror [data-box]:focus-within .box-settings {
          opacity: 1;
        }

        .resizable-image-container {
          display: inline-block;
          position: relative;
          max-width: 100%;
        }

        .resizable-image-container.selected,
        .ProseMirror .node-button.ProseMirror-selectednode > [data-node-view-wrapper],
        .ProseMirror .node-spacer.ProseMirror-selectednode > [data-node-view-wrapper],
        .ProseMirror .node-video.ProseMirror-selectednode > [data-node-view-wrapper],
        .ProseMirror .node-box.ProseMirror-selectednode > [data-node-view-wrapper],
        .ProseMirror hr.ProseMirror-selectednode {
          outline: 2px solid #3b82f6;
          outline-offset: 2px;
        }

        /* A divider is as thin as its line; a taller invisible band takes the clicks */
        .ProseMirror hr {
          position: relative;
          overflow: visible;
          cursor: pointer;
        }
        .ProseMirror hr::after {
          content: '';
          position: absolute;
          inset: -8px 0;
        }

        .resizable-image-container img {
          margin: 0;
        }

        .ProseMirror:focus {
          outline: none;
        }

        .ProseMirror p.is-empty::before {
          color: #9ca3af;
          content: attr(data-placeholder);
          float: left;
          height: 0;
          pointer-events: none;
        }
        .ProseMirror p.is-empty:not(.is-editor-empty)::before {
          color: #d1d5db;
        }

        /* Suggestion menus ({{, {% and /) */
        .tippy-box[data-theme~='variable-suggestion'] {
          background-color: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          box-shadow:
            0 4px 6px -1px rgba(0, 0, 0, 0.07),
            0 2px 4px -1px rgba(0, 0, 0, 0.04);
          padding: 4px;
          max-height: 320px;
          overflow-y: auto;
        }

        .tippy-box[data-theme~='variable-suggestion'] .tippy-content {
          padding: 0;
        }

        .suggestion-menu {
          width: 320px;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .suggestion-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 7px 10px;
          cursor: pointer;
          border-radius: 4px;
          /* Selection follows the pointer, so this only ever paints one row. */
          transition: background-color 0.12s ease-out;
        }

        /* Matches the focus:bg-neutral-100 used by Select and DropdownMenu: the same
           gesture gets the same highlight. Legible on its own because pointer movement
           moves the selection, so this is the only painted row rather than one of two
           competing ones. */
        .suggestion-row.is-selected {
          background-color: #f5f5f5;
        }

        .suggestion-row-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }

        .suggestion-row-label {
          font-size: 13px;
          line-height: 1.3;
          color: #171717;
        }

        .suggestion-row-meta {
          flex-shrink: 0;
          font-size: 11px;
          color: #525252;
          font-variant-numeric: tabular-nums;
        }

        .suggestion-row-syntax {
          font-family: 'Courier New', monospace;
          font-size: 11px;
          line-height: 1.3;
          color: #525252;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .suggestion-empty {
          padding: 12px;
          text-align: center;
          color: #525252;
          font-size: 13px;
        }

        @media (prefers-reduced-motion: reduce) {
          .suggestion-row {
            transition: none;
          }
        }

        .variable-mention {
          background-color: #dbeafe;
          color: #1e40af;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'Courier New', monospace;
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}

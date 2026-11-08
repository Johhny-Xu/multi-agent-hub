// Fixed DOM observation and guard scripts running strictly in the "omb" isolated world.
import { getSensitiveInputRuleData } from "./sensitive.ts";

export interface DomObservationResult {
  readonly id: string;
  readonly tabId?: string;
  readonly documentEpoch: string;
  readonly origin: string;
  readonly title: string;
  readonly stateText: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly elementId: string;
    readonly operation: "CLICK" | "TYPE_TEXT" | "SELECT";
    readonly role: string;
    readonly label: string;
    readonly value?: string;
    readonly checked?: boolean | "mixed";
    readonly selected?: boolean;
    readonly expanded?: boolean;
    readonly optionId?: string;
  }[];
  readonly controls: readonly ("SCROLL_UP" | "SCROLL_DOWN" | "WAIT")[];
  readonly guardId: string;
  readonly truncated: boolean;
  readonly omittedCandidates: number;
}

const { sensitiveFieldRegexSource, sensitiveFieldRegexFlags } = getSensitiveInputRuleData();

export const JEV_DOM_SCRIPT = `(() => {
  if (!document.body) return null;
  const state = globalThis.__ombJevState ||= {
    ids: new WeakMap(),
    nodes: new Map(),
    guards: new Map(),
    nextId: 1,
    epoch: String(Date.now()),
  };

  for (const [id, node] of state.nodes) {
    if (!node.isConnected) {
      state.nodes.delete(id);
    }
  }

  const identity = (el) => {
    if (!state.ids.has(el)) {
      state.ids.set(el, state.nextId++);
    }
    const id = state.ids.get(el);
    state.nodes.set(id, el);
    return id;
  };

  const sensitiveRe = new RegExp(${JSON.stringify(sensitiveFieldRegexSource)}, ${JSON.stringify(sensitiveFieldRegexFlags)});
  const isSensitive = (type, hints) => {
    if ((type || '').toLowerCase() === 'password') return true;
    const raw = hints.filter(Boolean).join(' ');
    const words = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
    return sensitiveRe.test(raw) || /(?:^| )(pin|security code)(?: |$)/.test(words);
  };

  const safe = (e) => !['file', 'hidden'].includes(e.type);
  const visible = (e) => {
    if (!e || e.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof e.checkVisibility === 'function') {
      return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = window.getComputedStyle(e);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    if (referenced) return referenced;
    const ariaLabel = e.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const labelText = [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ');
    if (labelText) return labelText;
    if (['button', 'submit', 'reset'].includes(e.type) && e.value) return e.value;
    const alt = e.getAttribute('alt');
    if (alt) return alt;
    if (e.tagName !== 'INPUT') {
      const children = [...e.childNodes].map((n) => {
        if (n.nodeType === 3) return n.textContent;
        if (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true') return name(n, seen);
        return '';
      }).join(' ').trim();
      if (children) return children;
    }
    return e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };

  const roles = [
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'
  ];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((r) => '[role="' + r + '"]').join(',');

  const getRole = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };

  const guardForNode = (e) => {
    if (!e || !e.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return {
      nodeId: identity(e),
      role: getRole(e),
      label: name(e),
      value: e.value ?? null,
      checked: e.checked ?? null,
      selectedIndex: e.selectedIndex ?? null,
      readOnly: e.readOnly ?? null,
      disabled: e.matches(':disabled'),
      ariaDisabled: e.getAttribute('aria-disabled'),
      ariaExpanded: e.getAttribute('aria-expanded'),
      ariaChecked: e.getAttribute('aria-checked'),
      ariaSelected: e.getAttribute('aria-selected'),
      href: e.getAttribute('href'),
      scopeText: (scope?.innerText || '').slice(0, 1000),
    };
  };

  const candidates = [];
  const guardId = 'g_' + Math.random().toString(36).slice(2, 10);
  const guardEntries = new Map();

  let elementCount = 0;
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const role = getRole(e);
    if (!role || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    if (role === 'gridcell' && e.querySelector('button,[role="button"]')) continue;

    const nodeId = identity(e);
    const elementId = 'el_' + nodeId;
    const label = (name(e) || role).slice(0, 160);
    const isSens = isSensitive(e.type, [e.id, e.name, e.getAttribute('autocomplete'), e.placeholder, label]);

    guardEntries.set(nodeId, guardForNode(e));
    elementCount++;
    if (elementCount > 64) break;

    const checkedAttr = e.getAttribute('aria-checked');
    const checkedVal = ['checkbox', 'radio'].includes(e.type)
      ? e.checked
      : checkedAttr === 'true'
        ? true
        : checkedAttr === 'false'
          ? false
          : checkedAttr === 'mixed'
            ? 'mixed'
            : undefined;

    const selectedAttr = e.getAttribute('aria-selected');
    const selectedVal = selectedAttr === 'true' ? true : selectedAttr === 'false' ? false : undefined;

    const expandedAttr = e.getAttribute('aria-expanded');
    const expandedVal = expandedAttr === 'true' ? true : expandedAttr === 'false' ? false : undefined;

    if (e.tagName === 'SELECT') {
      for (const opt of e.options) {
        if (!opt.selected && !opt.disabled && !opt.closest('optgroup[disabled]')) {
          candidates.push({
            id: 'c_' + candidates.length,
            elementId,
            operation: 'SELECT',
            role: 'combobox',
            label: (label + ' → ' + (opt.label || opt.text || opt.value)).slice(0, 160),
            value: isSens ? undefined : opt.value,
            selected: false,
            optionId: opt.value || opt.text,
          });
          if (candidates.length >= 128) break;
        }
      }
    } else {
      const isEditable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(role) || (role === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const rawVal = 'value' in e ? String(e.value) : e.isContentEditable || role === 'combobox' ? (e.innerText || '').trim() : undefined;
      const val = isSens ? undefined : (rawVal || '').slice(0, 200);

      if (isEditable) {
        candidates.push({
          id: 'c_' + candidates.length,
          elementId,
          operation: 'TYPE_TEXT',
          role,
          label,
          value: val,
        });
      }
      candidates.push({
        id: 'c_' + candidates.length,
        elementId,
        operation: 'CLICK',
        role,
        label: isEditable ? ('Open ' + label).slice(0, 160) : label,
        value: val,
        checked: checkedVal,
        selected: selectedVal,
        expanded: expandedVal,
      });
    }
    if (candidates.length >= 128) break;
  }

  // Text collection within viewport
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let textLen = 0;
  while ((node = walker.nextNode()) && textLen < 6000) {
    const val = (node.textContent || '').trim();
    const parent = node.parentElement;
    if (!val || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth) {
      words.push(val);
      textLen += val.length;
    }
  }

  const visibleText = words.join('\\n').slice(0, 6000);
  const controls = [];
  const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
  if (window.scrollY + window.innerHeight < scrollHeight - 2) controls.push('SCROLL_DOWN');
  if (window.scrollY > 0) controls.push('SCROLL_UP');
  if (document.querySelector('[aria-busy="true"],.loading,.spinner,[role="progressbar"]')) {
    controls.push('WAIT');
  }

  state.guards.set(guardId, {
    epoch: state.epoch,
    url: location.href,
    origin: location.origin,
    title: document.title,
    guardEntries,
  });

  const omitted = Math.max(0, candidates.length - 128);
  const keptCandidates = candidates.slice(0, 128);

  return {
    id: 'obs_' + Math.random().toString(36).slice(2, 10),
    documentEpoch: state.epoch,
    origin: location.origin,
    title: document.title,
    stateText: visibleText,
    candidates: keptCandidates,
    controls,
    guardId,
    truncated: omitted > 0 || textLen >= 6000,
    omittedCandidates: omitted,
  };
})()`;

export const JEV_RESOLVE_TARGET_SCRIPT = (elementId: string) => `(() => {
  const state = globalThis.__ombJevState;
  if (!state) return null;
  const numId = parseInt(${JSON.stringify(elementId)}.replace('el_', ''), 10);
  return state.nodes.get(numId) || null;
})()`;

export const JEV_VALIDATE_GUARD_SCRIPT = (guardId: string, elementId: string) => `(() => {
  const state = globalThis.__ombJevState;
  if (!state) return false;
  const saved = state.guards.get(${JSON.stringify(guardId)});
  if (!saved) return false;
  if (saved.epoch !== state.epoch) return false;
  if (saved.origin !== location.origin) return false;
  if (saved.url !== location.href) return false;

  const numId = parseInt(${JSON.stringify(elementId)}.replace('el_', ''), 10);
  const node = state.nodes.get(numId);
  if (!node || !node.isConnected) return false;

  const savedGuard = saved.guardEntries.get(numId);
  if (!savedGuard) return false;

  if (node.matches(':disabled') !== savedGuard.disabled) return false;
  if (node.readOnly !== savedGuard.readOnly) return false;
  if (node.value !== savedGuard.value) return false;
  if (node.checked !== savedGuard.checked) return false;
  if (node.selectedIndex !== savedGuard.selectedIndex) return false;

  return true;
})()`;

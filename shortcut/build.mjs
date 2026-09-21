// Generates "Hike map.shortcut" (an XML plist). Run: node shortcut/build.mjs
// The file is UNSIGNED: iOS 15+ only imports signed shortcuts. Sign on a Mac with
//   shortcuts sign --mode anyone --input "Hike map.shortcut" --output "Hike map signed.shortcut"
import fs from 'node:fs';
import path from 'node:path';

const PAGE = 'https://dominyko-labs.github.io/hike-map/';
const OBJ = '￼';                                   // placeholder character for an inline variable
const uuid = () => crypto.randomUUID().toUpperCase();

const U = { meta: uuid(), gps: uuid(), lat: uuid(), latRef: uuid(), lon: uuid(), lonRef: uuid(), exif: uuid(), dt: uuid(), text: uuid(), combined: uuid(), url: uuid() };
const G = { repeat: uuid(), cond: uuid() };

const out = (name, id) => ({ OutputName: name, OutputUUID: id, Type: 'ActionOutput' });
const attach = value => ({ Value: value, WFSerializationType: 'WFTextTokenAttachment' });
// A text field with inline variables: parts are strings or {out} objects.
const tokenString = parts => {
  let string = ''; const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') { string += part; continue; }
    attachmentsByRange[`{${string.length}, 1}`] = part; string += OBJ;
  }
  return { Value: { attachmentsByRange, string }, WFSerializationType: 'WFTextTokenString' };
};
const action = (id, params) => ({ WFWorkflowActionIdentifier: id, WFWorkflowActionParameters: params });
const getValue = (key, fromOut, id) => action('is.workflow.actions.getvalueforkey', {
  UUID: id, WFDictionaryKey: key, WFGetDictionaryValueType: 'Value', WFInput: attach(fromOut),
});

const actions = [
  action('is.workflow.actions.repeat.each', { GroupingIdentifier: G.repeat, WFControlFlowMode: 0, WFInput: attach({ Type: 'ExtensionInput' }) }),
  action('is.workflow.actions.properties.images', { UUID: U.meta, WFContentItemPropertyName: 'Metadata Dictionary', WFInput: attach({ Type: 'Variable', VariableName: 'Repeat Item' }) }),
  getValue('{GPS}', out('Metadata Dictionary', U.meta), U.gps),
  action('is.workflow.actions.conditional', { GroupingIdentifier: G.cond, WFControlFlowMode: 0, WFCondition: 100,
    WFInput: { Type: 'Variable', Value: out('Dictionary Value', U.gps), WFSerializationType: 'WFTextTokenAttachment' } }),
  getValue('Latitude', out('Dictionary Value', U.gps), U.lat),
  getValue('LatitudeRef', out('Dictionary Value', U.gps), U.latRef),
  getValue('Longitude', out('Dictionary Value', U.gps), U.lon),
  getValue('LongitudeRef', out('Dictionary Value', U.gps), U.lonRef),
  getValue('{Exif}', out('Metadata Dictionary', U.meta), U.exif),
  getValue('DateTimeOriginal', out('Dictionary Value', U.exif), U.dt),
  action('is.workflow.actions.gettext', { UUID: U.text, WFTextActionText: tokenString([
    out('Dictionary Value', U.lat), out('Dictionary Value', U.latRef), '|',
    out('Dictionary Value', U.lon), out('Dictionary Value', U.lonRef), '|',
    out('Dictionary Value', U.dt)]) }),
  action('is.workflow.actions.appendvariable', { WFVariableName: 'points', WFInput: attach(out('Text', U.text)) }),
  action('is.workflow.actions.conditional', { GroupingIdentifier: G.cond, WFControlFlowMode: 2 }),
  action('is.workflow.actions.repeat.each', { GroupingIdentifier: G.repeat, WFControlFlowMode: 2 }),
  action('is.workflow.actions.text.combine', { UUID: U.combined, WFTextSeparator: 'Custom', WFTextCustomSeparator: ';',
    text: attach({ Type: 'Variable', VariableName: 'points' }) }),
  action('is.workflow.actions.url', { UUID: U.url, WFURLActionURL: tokenString([PAGE + '#p=', out('Combined Text', U.combined), '&n=Alta%20Via%201']) }),
  action('is.workflow.actions.openurl', { WFInput: attach(out('URL', U.url)) }),
];

const shortcut = {
  WFWorkflowActions: actions,
  WFWorkflowClientVersion: '1200',
  WFWorkflowHasShortcutInputVariables: true,
  WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59511, WFWorkflowIconStartColor: 431817727 },
  WFWorkflowImportQuestions: [],
  WFWorkflowInputContentItemClasses: ['WFImageContentItem'],
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowMinimumClientVersionString: '900',
  WFWorkflowOutputContentItemClasses: [],
  WFWorkflowTypes: ['ActionExtension'],
};

// ---- tiny plist writer ----
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(v, ind) {
  const pad = '\t'.repeat(ind);
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>\n`;
  if (typeof v === 'boolean') return `${pad}<${v}/>\n`;
  if (typeof v === 'number') return `${pad}<${Number.isInteger(v) ? 'integer' : 'real'}>${v}</${Number.isInteger(v) ? 'integer' : 'real'}>\n`;
  if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map(x => plist(x, ind + 1)).join('')}${pad}</array>\n` : `${pad}<array/>\n`;
  const keys = Object.keys(v).sort();
  if (!keys.length) return `${pad}<dict/>\n`;
  return `${pad}<dict>\n${keys.map(k => `${pad}\t<key>${esc(k)}</key>\n${plist(v[k], ind + 1)}`).join('')}${pad}</dict>\n`;
}
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n' + plist(shortcut, 0) + '</plist>\n';
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), 'Hike map.shortcut');
fs.writeFileSync(dest, xml);
console.log(`wrote ${dest} (${xml.length} bytes, ${actions.length} actions)`);

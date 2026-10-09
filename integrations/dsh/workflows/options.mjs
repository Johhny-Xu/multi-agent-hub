// Shared validation for the deterministic runner. Workflow VM bodies inline it.
export function workflowOptions(input) {
  const options = {};
  for (const key of ['model', 'cwd']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error('Invalid ' + key);
    options[key] = input[key];
  }
  if (input.thinking !== undefined) {
    if (!['default', 'on', 'off'].includes(input.thinking)) throw new Error('Invalid thinking');
    options.thinking = input.thinking;
  }
  if (input.stream !== undefined) {
    if (typeof input.stream !== 'boolean') throw new Error('Invalid stream');
    options.stream = input.stream;
  }
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.length > 8 || input.files.some(file => typeof file !== 'string' || !file.trim())) throw new Error('Invalid files');
    options.files = [...input.files];
  }
  return options;
}

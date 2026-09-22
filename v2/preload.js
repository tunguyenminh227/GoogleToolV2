const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const result = await ipcRenderer.invoke(channel, value);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

contextBridge.exposeInMainWorld('googleTool', {
  logTrace: record => ipcRenderer.send('v2:ui-trace', record),
  load: () => invoke('v2:load'),
  saveNotes: input => invoke('v2:notes-save', input),
  createProfile: input => invoke('v2:create', input),
  createProfiles: text => invoke('v2:create-batch', text),
  onCreateProgress: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('v2:create-progress', listener);
    return () => ipcRenderer.removeListener('v2:create-progress', listener);
  },
  deleteProfile: id => invoke('v2:delete', id),
  deleteProfiles: ids => invoke('v2:delete-batch', ids),
  getTemplate: () => invoke('v2:template-get'),
  saveTemplate: value => invoke('v2:template-save', value),
  editFingerprint: value => invoke('v2:fingerprint-save', value),
  openProfile: id => invoke('v2:open', id),
  openProfiles: input => invoke('v2:open-batch', input),
  cancelOpenQueue: () => invoke('v2:open-cancel'),
  setOpenLimit: limit => invoke('v2:open-limit', limit),
  loginGmail: id => invoke('v2:login-gmail', id),
  checkIphey: id => invoke('v2:check-iphey', id),
  chooseChrome: () => invoke('v2:choose-chrome'),
  onChanged: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('v2:changed', listener);
    return () => ipcRenderer.removeListener('v2:changed', listener);
  },
});

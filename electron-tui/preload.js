const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  listHistory: ()              => ipcRenderer.invoke('history:list'),
  spawn:       (opts)          => ipcRenderer.invoke('pty:spawn', opts),
  write:       (id, data)      => ipcRenderer.invoke('pty:write', { id, data }),
  resize:      (id, cols, rows)=> ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  kill:        (id)            => ipcRenderer.invoke('pty:kill', { id }),
  list:        ()              => ipcRenderer.invoke('pty:list'),
  onData:      (cb) => ipcRenderer.on('pty:data', (_e, msg) => cb(msg)),
  onExit:      (cb) => ipcRenderer.on('pty:exit', (_e, msg) => cb(msg)),
});

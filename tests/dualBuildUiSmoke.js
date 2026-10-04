// SPDX-License-Identifier: GPL-3.0-only
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const fsSync=require('node:fs');const os=require('node:os');const path=require('node:path');
const {pathToFileURL}=require('node:url');const {app,BrowserWindow,ipcMain}=require('electron');
const sourceRoot=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const withUpdates=process.argv[3]!=='no-updates';const output=path.resolve(process.argv[4]||os.tmpdir());
const profile=fsSync.mkdtempSync(path.join(os.tmpdir(),'lar-dual-ui-'));
app.setPath('userData',profile);app.setPath('sessionData',path.join(profile,'session'));
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');
const ID='646B350F36C6D3E4';const otherID='618C2492CC62D0D5';const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let n=0;n<100;n++){if(await predicate())return;await wait(20);}throw new Error('UI condition timed out');}
app.whenReady().then(async()=>{
 await fs.mkdir(output,{recursive:true});const report={withUpdates,checks:[],screenshots:[]};
 let settings={language:'ru',gameExecutable:'C:\\Steam\\ArmaReforgerSteam.exe',addonsDirectory:path.join(profile,'addons'),downloadRoot:profile,profileDirectory:profile,autoUpdate:true,showModLogsFooter:true,autoAddDependencies:true,confirmModDeletion:true,favoriteMods:[],favoriteServers:[]};
 let installed=[{modId:ID,name:'Card test',version:'1.0',directoryPath:path.join(profile,'addons','Card'),corrupted:false,dependencies:[]}];
 let detailsMode='normal',detailsVersion='1.0';const detailsCalls=[],held=[];
 const detail=id=>({modId:id,name:'Card '+id,version:detailsVersion,summary:'Immediate cached information',description:'Test description',dependencies:[],versions:[],previewUrls:[],screenshotUrls:[],tags:[],scenarios:[]});
 let updateChecks=0,modUpdates=0,installs=0,updateReply={state:'current',status:{state:'current',revision:1}},updateGate=null;
 ipcMain.handle('launcher:bootstrap',()=>({appVersion:'0.3.65',packaged:true,platform:'win32',updateMode:withUpdates?'automatic':undefined,buildIdentity:{status:'open-source',releaseTier:withUpdates?'public-unsigned':'community',authenticode:'unsigned',version:'0.3.65'},settings,installedMods:installed,presets:[],workspace:{},modLogCount:0}));
 ipcMain.handle('mods:scan',()=>installed);ipcMain.handle('workspace:save',(_e,x)=>x);
 ipcMain.handle('settings:save',(_e,x)=>{settings={...settings,...x};return settings;});
 ipcMain.handle('game:download-status',()=>({state:'idle',completed:0,total:0,progress:0}));
 ipcMain.handle('mod-logs:list',()=>[]);ipcMain.handle('mod-logs:add-many',()=>[]);ipcMain.handle('mod-logs:add',()=>({}));
 ipcMain.handle('presets:list',()=>[]);ipcMain.handle('servers:list',()=>({items:[],page:1,pageSize:50,hasNext:false}));
 ipcMain.handle('workshop:search',()=>({items:[detail(ID),detail(otherID)],page:1,count:2,pageSize:24}));
 ipcMain.handle('mods:details',async(_e,id,options)=>{
  detailsCalls.push({id,refresh:options?.refresh===true});
  if(detailsMode==='hold')return new Promise((resolve,reject)=>held.push({id,resolve,reject}));
  if(detailsMode==='error')throw new Error('Simulated Workshop network failure');
  if(detailsMode==='wrong')return detail(otherID);
  return detail(id);
 });
 ipcMain.handle('mods:update',(_e,payload)=>{modUpdates++;return{alreadyUpToDate:true,checkedCount:payload.modIds.length,queuedCount:0,skippedCount:0};});
 for(const channel of ['updates:check','updates:download','updates:install'])ipcMain.handle(channel,async()=>{
  assert.ok(withUpdates,'No-updates build attempted an update IPC request');
  if(channel==='updates:check'){updateChecks++;if(updateGate)await updateGate;return updateReply;}
  if(channel==='updates:install')installs++;return true;
 });
 const window=new BrowserWindow({show:false,width:1380,height:850,webPreferences:{preload:path.join(sourceRoot,'src/main/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 const js=async x=>{try{return await window.webContents.executeJavaScript(x);}catch(error){throw new Error(`${error.message}; renderer expression: ${x.slice(0,250)}`,{cause:error});}};
 const watchdog=setTimeout(()=>{process.stderr.write('Dual-build UI audit timeout\n');app.exit(1);},60_000);watchdog.unref();
 await window.loadURL(pathToFileURL(path.join(sourceRoot,'src/renderer/index.html')).href);
 await until(()=>js(`$('#appVersion').textContent==='v0.3.65' && !state.busy`));
 const check=(label,condition)=>{assert.ok(condition,label);report.checks.push(label);process.stdout.write(`PASS ${label}\n`);};
 async function screenshot(name){await wait(250);await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const file=path.join(output,name+'.png');for(let attempt=0;attempt<3;attempt++){try{window.webContents.invalidate();await fs.writeFile(file,(await window.capturePage()).toPNG());report.screenshots.push(file);return;}catch(error){if(!String(error.message).includes('UnknownVizError')||attempt===2)throw error;await wait(100);}}}
 check('all eight pages work in RU and EN',await js(`(async()=>{for(const language of ['ru','en']){await changeLanguage(language);for(const view of Object.keys(viewMetadata)){setView(view);if(!$('#view-'+view).classList.contains('active'))return false;}}setView('settings');return Object.keys(viewMetadata).length===8;})()`));
 check('partners card opens and returns to list',await js(`(()=>{setView('partners');const card=$('#partnersGrid [data-partner-id]');if(!card)return false;card.click();const open=!$('#partnerDetail').hidden;$('#partnersBack').click();return open && $('#partnerDetail').hidden;})()`));
 await js('setView("mods")');await js(`openModDetails('${ID}')`);
 check('card information loads and refresh control is usable',await js(`state.modDetails.data.modId==='${ID}' && !$('#refreshModDetails').disabled`));
 check('missing optional Workshop fields do not display undefined',await js(`!$('#modDetailsBody').textContent.includes('undefined')`));
 const before=detailsCalls.length;for(let n=0;n<30;n++)await js(`openModDetails('${ID}')`);
 check('30 repeat openings render cached information without network requests',detailsCalls.length===before);
 detailsMode='hold';const refresh=js(`openModDetails('${ID}',{refresh:true})`);await until(()=>held.length===1);
 check('cached information stays visible during refresh',await js(`Boolean($('#modDetailsBody .mod-details-facts')) && $('#refreshModDetails').disabled`));
 held.shift().resolve({...detail(ID),version:'2.0'});await refresh;
 check('explicit refresh bypasses caches',detailsCalls.at(-1).refresh && await js(`state.modDetails.data.version==='2.0'`));
 detailsMode='error';await js(`openModDetails('${ID}',{refresh:true})`);
 check('network failure preserves cached facts and enables retry',await js(`Boolean($('#modDetailsBody .mod-details-facts')) && state.modDetails.error.length>0 && !$('#refreshModDetails').disabled`));
 detailsMode='normal';detailsVersion='3.0';await js(`openModDetails('${ID}',{refresh:true})`);
 check('retry recovers after a network failure',await js(`state.modDetails.data.version==='3.0' && !state.modDetails.error`));
 detailsMode='hold';const oldPending=js(`openModDetails('${ID}',{refresh:true})`);await until(()=>held.length===1);
 const old=held.shift();const newPending=js(`openModDetails('${otherID}',{refresh:true})`);await until(()=>held.length===1);
 held.shift().resolve(detail(otherID));await newPending;old.resolve(detail(ID));await oldPending;
 check('out-of-order responses never replace another mod card',await js(`state.modDetails.data.modId==='${otherID}' && $('#modDetailsTitle').textContent.includes('${otherID}')`));
 detailsMode='normal';await js(`closeModDetails();openModDetails('${ID}')`);await until(()=>js('!state.modDetails.loading'));
 installed=[{...installed[0],version:'2.0'}];await js(`state.installedMods=${JSON.stringify(installed)};openModDetails('${ID}')`);
 check('a changed installed version forces fresh Workshop information',detailsCalls.at(-1).refresh);
 const beforeModUpdate=modUpdates;check('installed mod update button is enabled',await js(`!$('#updateModDetails').disabled`));await js(`$('#updateModDetails').click()`);await until(()=>modUpdates===beforeModUpdate+1);await until(()=>js('!state.busy'));
 check('installed mod updates remain available in both variants',true);
 detailsMode='hold';await js(`window.auditOriginalTimeout=requestWithTimeout;requestWithTimeout=(promise,ms,message)=>{window.auditTimeoutMs=ms;return auditOriginalTimeout(promise,25,message);};void 0;`);
 await js(`openModDetails('${ID}',{refresh:true})`);
 check('a stalled IPC request exits loading and permits retry',await js(`auditTimeoutMs===18000 && !state.modDetails.loading && !$('#refreshModDetails').disabled && state.modDetails.error.length>0`));
 for(const request of held.splice(0))request.resolve(detail(request.id));
 await js('requestWithTimeout=auditOriginalTimeout;void 0;');detailsMode='normal';await js(`openModDetails('${ID}',{refresh:true})`);
 detailsMode='wrong';await js(`openModDetails('${ID}',{refresh:true})`);
 check('a response for the wrong GUID is rejected',await js(`state.modDetails.data.modId==='${ID}' && state.modDetails.error.length>0`));
 detailsMode='normal';await js(`openModDetails('${ID}',{refresh:true})`);await screenshot('card');await js('closeModDetails()');
 if(withUpdates){
  window.webContents.send('updates:status',{state:'downloaded',revision:10,info:{version:'0.3.66'}});
  await until(()=>js(`$('#titlebarUpdate').classList.contains('ready')`));
  updateReply={state:'available',status:{state:'available',revision:9,info:{version:'0.3.66'}}};
  await js('checkUpdates(true)');
  check('late update replies preserve the green Install update action',await js(`state.updateStatus.state==='downloaded' && !$('#titlebarUpdate').hidden && !$('#titlebarUpdate').disabled && $('#titlebarUpdate').classList.contains('ready')`));
  await js(`$('#titlebarUpdate').click()`);await until(()=>installs===1);
  check('green action invokes installer exactly once',true);
  await js('setView("dashboard")');await screenshot('ready-update');
 }else{
  check('launcher updater API and controls are completely absent',await js(`!['checkForUpdates','downloadUpdate','installUpdate','onUpdateStatus'].some(key=>typeof api[key]==='function') && !$('#titlebarUpdate') && !$('#checkUpdates') && !$('#settingAutoUpdate') && !$('#mandatoryUpdateDialog')`));
  window.webContents.send('updates:status',{state:'downloaded',info:{version:'99.0.0'}});await wait(50);
  check('no launcher update IPC requests occur',updateChecks===0&&installs===0);
 }
 for(const [width,height]of [[1080,720],[1920,1080]]){window.setContentSize(width,height);for(const view of ['parameters','settings','partners']){
  await js(`setView('${view}')`);await screenshot(view+'-'+width);
  check(view+' fits viewport '+width,await js(`document.documentElement.scrollWidth<=innerWidth+1`));
 }}
 clearTimeout(watchdog);await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 process.stdout.write(JSON.stringify(report,null,2)+'\n');app.quit();
}).catch(error=>{process.stderr.write((error.stack||error)+'\n');app.exit(1);});

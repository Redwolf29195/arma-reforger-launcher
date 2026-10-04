// SPDX-License-Identifier: GPL-3.0-only
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {findGameExecutable,findSteamExecutable,resolveGameExecutable}=require('../src/core/gameLocator');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'lar-steam-windows-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function install(library,folder='Arma Reforger',appid='1874880') {
 const directory=path.join(library,'steamapps','common',folder);await fs.mkdir(directory,{recursive:true});
 const file=path.join(directory,'ArmaReforgerSteam.exe');await fs.writeFile(file,'fixture');
 await fs.writeFile(path.join(library,'steamapps','appmanifest_1874880.acf'),`"AppState" { "appid" "${appid}" "installdir" "${folder}" }`);return file;
}
const vdfPath=x=>x.replaceAll('\\','\\\\');
test('Windows finds registry Steam roots and custom manifest install directories',async t=>{
 const root=await fixture(t),steam=path.join(root,'Custom Steam'),library=path.join(root,'Games');
 await fs.mkdir(path.join(steam,'steamapps'),{recursive:true});await fs.writeFile(path.join(steam,'steam.exe'),'fixture');
 const game=await install(library,'Moved Reforger');await fs.writeFile(path.join(steam,'steamapps','libraryfolders.vdf'),`"libraryfolders" { "1" { "path" "${vdfPath(library)}" } }`);
 const options={platform:'win32',steamRoots:[],registryRoots:[steam],env:{}};
 assert.equal(await findGameExecutable('',options),game);assert.equal(await findSteamExecutable(game,options),path.join(steam,'steam.exe'));
});
test('Windows handles legacy numeric library entries and rejects missing stored paths',async t=>{
 const root=await fixture(t),steam=path.join(root,'Steam'),library=path.join(root,'Second library');
 await fs.mkdir(path.join(steam,'steamapps'),{recursive:true});const game=await install(library);
 await fs.writeFile(path.join(steam,'steamapps','libraryfolders.vdf'),`"libraryfolders" { "1" "${vdfPath(library)}" }`);
 assert.equal(await findGameExecutable(path.join(root,'deleted','ArmaReforgerSteam.exe'),{platform:'win32',steamRoots:[steam]}),game);
});
test('manifest installation wins over an obsolete guessed game copy',async t=>{
 const root=await fixture(t),steam=path.join(root,'Steam');const game=await install(steam,'Current Reforger');
 const obsolete=path.join(steam,'steamapps','common','Arma Reforger');await fs.mkdir(obsolete,{recursive:true});await fs.writeFile(path.join(obsolete,'ArmaReforgerSteam.exe'),'old fixture');
 assert.equal(await findGameExecutable('',{platform:'win32',steamRoots:[steam]}),game);
 assert.equal(await findGameExecutable(steam,{platform:'win32',steamRoots:[steam]}),game);
 assert.equal(await resolveGameExecutable(steam,{platform:'win32',steamRoots:[steam]}),game);
 assert.equal(await findGameExecutable(path.join(obsolete,'ArmaReforgerSteam.exe'),{platform:'win32',steamRoots:[steam]}),game);
 const manual=path.join(root,'Manual copy');await fs.mkdir(manual);const manualExe=path.join(manual,'ArmaReforgerSteam.exe');await fs.writeFile(manualExe,'manual fixture');
 assert.equal(await findGameExecutable(manualExe,{platform:'win32',steamRoots:[steam]}),manualExe);
});
test('Steam library moves are re-read on every detection without a stale path cache',async t=>{
 const root=await fixture(t),steam=path.join(root,'Steam'),first=path.join(root,'First'),second=path.join(root,'Second');
 await fs.mkdir(path.join(steam,'steamapps'),{recursive:true});const game1=await install(first),game2=await install(second);
 const config=path.join(steam,'steamapps','libraryfolders.vdf');const options={platform:'win32',steamRoots:[steam]};
 await fs.writeFile(config,`"libraryfolders" { "1" { "path" "${vdfPath(first)}" } }`);assert.equal(await findGameExecutable('',options),game1);
 await fs.rm(path.join(first,'steamapps','appmanifest_1874880.acf'));
 await fs.writeFile(config,`"libraryfolders" { "1" { "path" "${vdfPath(second)}" } }`);assert.equal(await findGameExecutable('',options),game2);
 assert.equal(await findGameExecutable(game1,options),game2);
});
test('corrupt metadata or another Steam app never resolves a custom folder as Reforger',async t=>{
 const root=await fixture(t),steam=path.join(root,'Steam');await install(steam,'Different Game','123');
 const options={platform:'win32',steamRoots:[steam]};assert.equal(await findGameExecutable('',options),'');
 await fs.writeFile(path.join(steam,'steamapps','appmanifest_1874880.acf'),'truncated {');assert.equal(await findGameExecutable('',options),'');
});

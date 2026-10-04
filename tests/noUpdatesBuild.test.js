// SPDX-License-Identifier: GPL-3.0-only
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {prepareBuild}=require('../scripts/prepare-build');const {UPDATER_FILES,removeLauncherUpdates}=require('../scripts/no-updates-build');
const root=path.resolve(__dirname,'..');const metadata=require('../package.json');
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lar-build-flavors-'));
 t.after(async()=>{try{await fs.unlink(path.join(dir,'.build/app/node_modules'));}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rm(dir,{recursive:true,force:true});});
 await fs.cp(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
 await fs.mkdir(path.join(dir,'node_modules'));await fs.mkdir(path.join(dir,'support/ALGZLauncherWorkshopBridge'),{recursive:true});
 for(const file of ['package.json','LICENSE','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,file),path.join(dir,file));
 return dir;
}
test('no-updates build removes code, IPC, controls, feeds, keys, settings and updater dependencies',async t=>{
 const config=require('../electron-builder.no-updates.cjs');
 assert.equal(config.directories.app,metadata.build.directories.app);
 assert.equal(config.productName,metadata.build.productName);
 assert.equal(config.afterPack,metadata.build.afterPack);
 assert.equal(config.win.icon,metadata.build.win.icon);
 assert.deepEqual(config.files.slice(0,-1),metadata.build.files);
 assert.equal(config.files.at(-1),'!node_modules{,/**/*}');
 assert.equal(config.publish,null);
 const dir=await fixture(t);const built=await prepareBuild(dir,['--no-updates']);
 assert.equal(built.launcherUpdates,false);const pkg=JSON.parse(await fs.readFile(path.join(built.stagedAppRoot,'package.json')));
 assert.equal(pkg.version,metadata.version);assert.deepEqual(pkg.dependencies,{});
 await assert.rejects(fs.access(path.join(built.stagedAppRoot,'node_modules')),{code:'ENOENT'});
 for(const file of UPDATER_FILES)await assert.rejects(fs.access(path.join(built.stagedAppRoot,file)),{code:'ENOENT'});
 for(const file of ['src/main/main.js','src/main/preload.js','src/core/settingsStore.js','src/core/buildIdentity.js','src/renderer/app.js','src/renderer/index.html']) {
  const source=await fs.readFile(path.join(built.stagedAppRoot,file),'utf8');
  assert.doesNotMatch(source,/electron-updater|autoUpdater|updates:|updateCheckScheduler|updateMode|settingAutoUpdate|titlebarUpdate|algzUpdatePolicy|UPDATE_CHANNEL_URL|autoUpdate/);
 }
 const preload=await fs.readFile(path.join(built.stagedAppRoot,'src/main/preload.js'),'utf8');
 assert.match(preload,/updateInstalledMods/);assert.match(preload,/installWorkshopMod/);assert.match(preload,/getModDetails/);
 for(const file of ['src/core/workshopDetails.js','src/core/gameLocator.js','src/core/modScanner.js','src/core/presetStore.js'])assert.deepEqual(await fs.readFile(path.join(root,file)),await fs.readFile(path.join(built.stagedAppRoot,file)));
});
test('updating build retains authenticated updates with the same common fixes and version',async t=>{
 const dir=await fixture(t);const built=await prepareBuild(dir,['--public-unsigned']);assert.equal(built.launcherUpdates,true);
 const pkg=JSON.parse(await fs.readFile(path.join(built.stagedAppRoot,'package.json')));assert.equal(pkg.version,metadata.version);assert.equal(pkg.dependencies['electron-updater'],'6.8.9');
 for(const file of UPDATER_FILES)await fs.access(path.join(built.stagedAppRoot,file));
 assert.match(await fs.readFile(path.join(built.stagedAppRoot,'src/main/main.js'),'utf8'),/verifyDownloadedUpdate/);
});
test('unreviewed source changes fail the no-updates build instead of silently shipping an updater',async t=>{
 const dir=await fixture(t);const main=path.join(dir,'src/main/main.js');
 await fs.writeFile(main,(await fs.readFile(main,'utf8')).replace('function safeUpdateErrorMessage(error)','function renamedUpdateErrorMessage(error)'));
 await assert.rejects(removeLauncherUpdates(dir),/removal plan needs review/);
});

module.exports = {}; fs.mkdirSync(execEnv.buildDir,{recursive:true}); fs.writeFileSync(require('path').join(execEnv.buildDir,'package.json'), JSON.stringify({name:'gen',version:'1.0.0'}));

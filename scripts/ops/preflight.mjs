import {readConfig,inspectReleaseConfig} from './release-config.mjs';
try{
  const report=inspectReleaseConfig(await readConfig());
  console.log(JSON.stringify(report,null,2));
  if(!report.configurationReady)process.exitCode=2;
}catch{console.error('发布配置预检失败；未读取Secrets，未访问远程资源');process.exitCode=1;}

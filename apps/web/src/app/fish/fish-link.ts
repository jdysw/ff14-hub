import type {FishRegion} from '@ff14-hub/shared';
export interface FishLink{region:FishRegion;fishId:number;windowStartsAt?:number}
export function parseFishLink(search:string):FishLink|null{
  const params=new URLSearchParams(search);
  if(params.get('view')!=='fish')return null;
  const region=params.get('region'),rawId=params.get('fish')??'',rawWindow=params.get('window');
  if((region!=='cn'&&region!=='global')||!/^\d+$/.test(rawId))return null;
  const fishId=Number(rawId);
  if(!Number.isSafeInteger(fishId)||fishId<=0)return null;
  if(rawWindow!==null&&(!/^\d+$/.test(rawWindow)||!Number.isSafeInteger(Number(rawWindow))||Number(rawWindow)>Date.UTC(2100,0,1)))return null;
  return {region,fishId,...(rawWindow!==null?{windowStartsAt:Number(rawWindow)}:{})};
}
export function fishLinkFromJob(key:string):FishLink|null{
  const match=/^fish:(cn|global):(\d+):(\d+):\d+$/.exec(key);
  if(!match)return null;
  return parseFishLink(`view=fish&region=${match[1]}&fish=${match[2]}&window=${match[3]}`);
}

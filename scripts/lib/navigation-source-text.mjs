/** Read snapshot markup as plain data. Complete tags become spaces; incomplete tags stay literal. */
export function cleanNavigationSourceText(text){
  const parts=[];
  let cursor=0;
  while(cursor<text.length){
    const open=text.indexOf('<',cursor);
    if(open<0){break;}
    const close=text.indexOf('>',open+1);
    if(close<0){break;}
    parts.push(text.slice(cursor,open),' ');
    cursor=close+1;
  }
  parts.push(text.slice(cursor));
  return parts.join('').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0]==='x'?Number.parseInt(n.slice(1),16):Number(n)))
    .replaceAll('&amp;','&').replaceAll('&nbsp;',' ').replaceAll('&quot;','"').replace(/\s+/g,' ').trim();
}

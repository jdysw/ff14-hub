function quotedCsvStep(text,index,field){
  if(text[index]!=='"'){return {field:field+text[index],quoted:true,index};}
  if(text[index+1]==='"'){return {field:field+'"',quoted:true,index:index+1};}
  return {field,quoted:false,index};
}
/** RFC4180, including multiline quoted fields in game CSV exports. */
export function csvRows(text){
  const rows=[];let row=[],field='',quoted=false,cursor=0;
  while(cursor<text.length){
    const c=text[cursor];
    if(quoted){
      const next=quotedCsvStep(text,cursor,field);
      field=next.field;quoted=next.quoted;cursor=next.index+1;
      continue;
    }
    if(c==='"'&&field===''){quoted=true;}
    else if(c===','){row.push(field);field='';}
    else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}
    else if(c!=='\r'){field+=c;}
    cursor++;
  }
  if(quoted){throw new Error('Incomplete CSV');}
  if(row.length||field){row.push(field);rows.push(row);}
  return rows;
}
export function csvTable(text){
  const rows=csvRows(text.replace(/^\uFEFF/,''));
  if(rows[1]?.[0]!=='#'){throw new Error('Unexpected game CSV header');}
  return rows.slice(3).map(row=>Object.fromEntries(rows[1].map((key,i)=>[i===0?'id':key,row[i]??''])));
}

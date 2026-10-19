/** RFC4180, including multiline quoted fields in game CSV exports. */
export function csvRows(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}
    else if(c==='"'&&field==='')quoted=true;
    else if(c===','){row.push(field);field='';}
    else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}
    else if(c!=='\r')field+=c;
  }
  if(quoted)throw new Error('Incomplete CSV');
  if(row.length||field){row.push(field);rows.push(row);}
  return rows;
}
export function csvTable(text){
  const rows=csvRows(text.replace(/^\uFEFF/,''));
  if(rows[1]?.[0]!=='#')throw new Error('Unexpected game CSV header');
  return rows.slice(3).map(row=>Object.fromEntries(rows[1].map((key,i)=>[i===0?'id':key,row[i]??''])));
}

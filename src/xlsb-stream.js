import { Unzip, UnzipInflate } from 'fflate';

// Read only XLSB cell values; styles, formulas and drawing objects are not needed
// for SalesReport. Record layouts follow MS-XLSB (BrtRowHdr/BrtCell*/RichStr).
// ZIP data and binary records are consumed incrementally, never as a worksheet.
const decoder=new TextDecoder('utf-16le');
function wide(data,offset) {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const count=view.getUint32(offset,true),end=offset+4+count*2;
  if(count>1_000_000 || end>data.length) throw new Error('Invalid XLSB string');
  return decoder.decode(data.subarray(offset+4,end));
}
function records(onRecord) {
  let rest=new Uint8Array();
  return (chunk,final)=>{
    let data=chunk;
    if(rest.length) {data=new Uint8Array(rest.length+chunk.length);data.set(rest);data.set(chunk,rest.length);}
    let at=0;
    while(at<data.length) {
      const start=at;let type=data[at++];
      if(type&128) {if(at===data.length){at=start;break;}type=(type&127)+((data[at++]&127)<<7);}
      let len=0,shift=0,complete=false;
      while(at<data.length && shift<28) {const b=data[at++];len+=(b&127)*2**shift;shift+=7;if(!(b&128)){complete=true;break;}}
      if(!complete){at=start;break;}
      if(len>4*1024*1024) throw new Error('XLSB record exceeds limit');
      if(at+len>data.length){at=start;break;}
      onRecord(type,data.subarray(at,at+len));at+=len;
    }
    rest=data.slice(at);
    if(final && rest.length) throw new Error('Truncated XLSB record');
  };
}
function unzipEntries(bytes,select,limit=256*1024*1024) {
  let expanded=0;
  const unzip=new Unzip(file=>{
    const consume=select(file.name);
    if(!consume) return;
    file.ondata=(err,data,final)=>{
      if(err) throw err;
      expanded+=data.length;
      if(expanded>limit) throw new Error('Expanded workbook exceeds limit');
      consume(data,final);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for(let at=0;at<bytes.length;at+=16384) unzip.push(bytes.subarray(at,at+16384),at+16384>=bytes.length);
}
export function assertSmallArchive(bytes) {
  if(bytes[0]===0x50 && bytes[1]===0x4b) unzipEntries(bytes,()=>()=>{},12*1024*1024);
}
export function streamXlsbRows(bytes,onSheet) {
  const strings=[];let stringChars=0;
  unzipEntries(bytes,name=>name==='xl/sharedStrings.bin'?records((type,data)=>{
    if(type!==0x13)return;
    const value=wide(data,1);stringChars+=value.length;
    if(stringChars>4_000_000 || strings.length>=300_000) throw new Error('Shared string table exceeds limit');
    strings.push(value);
  }):null);
  unzipEntries(bytes,name=>{
    if(!/^xl\/worksheets\/[^/]+\.bin$/.test(name))return null;
    const onRow=onSheet(name);if(!onRow)return null;
    let row=null,rowNumber=-1,col=-1;
    const push=records((type,data)=>{
      const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
      if(type===0) {if(row)onRow(row,rowNumber);rowNumber=view.getUint32(0,true);if(rowNumber>1_048_575)throw new Error('Invalid row');row=[];col=-1;return;}
      if(!row || !((type>=1 && type<=0x12)||type===0x3e))return;
      const short=type>=0x0c && type<=0x12,offset=short?4:8;
      col=short?col+1:view.getUint32(0,true);
      if(col>16383)throw new Error('Invalid column');
      const base=short?type-0x0b:type;
      let value=null;
      if(base===2) {
        const raw=view.getInt32(offset,true);
        if(raw&2)value=raw>>2;
        else {const b=new ArrayBuffer(8),v=new DataView(b);v.setInt32(4,raw&~3,true);value=v.getFloat64(0,true);}
        if(raw&1)value/=100;
      } else if(base===5 || type===9)value=view.getFloat64(offset,true);
      else if(base===6 || type===8)value=wide(data,offset);
      else if(base===7) {const id=view.getUint32(offset,true);if(id>=strings.length)throw new Error('Invalid shared string reference');value=strings[id];}
      else if(base===4 || type===10)value=!!data[offset];
      else if(base===3 || type===11)value='#ERROR';
      else if(type===0x3e)value=wide(data,offset+1);
      row[col]=value;
    });
    return (chunk,final)=>{push(chunk,final);if(final&&row){onRow(row,rowNumber);row=null;}};
  });
}

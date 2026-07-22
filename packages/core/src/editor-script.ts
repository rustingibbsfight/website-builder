/**
 * Editor-mode script injected into preview pages when the visual editor loads
 * them in its canvas iframe (?editor=1). Never part of published output.
 *
 * Protocol (window.postMessage with the parent editor):
 *  in:  {type:'wb:select-node', nodeId}            → outline + scroll to node
 *  in:  {type:'wb:hittest', x, y, containerIds}    → find drop target under point
 *  in:  {type:'wb:clear-indicator'}
 *  in:  {type:'wb:set-containers', containerIds}   → valid drop parents for in-canvas drag
 *  in:  {type:'wb:edit-begin', nodeId}             → start inline text editing on a node
 *  out: {type:'wb:ready'}
 *  out: {type:'wb:clicked', nodeId}
 *  out: {type:'wb:dblclick', nodeId}               → editor decides if node is text-editable
 *  out: {type:'wb:text-commit', nodeId, text}      → new plain text for the node
 *  out: {type:'wb:drop-target', containerId, index, rect:{...}}
 *  out: {type:'wb:move-node', nodeId, containerId, index}  → drag-reorder result
 */
export const EDITOR_PREVIEW_JS = `(function(){
var selected=null;
var editing=null;   // nodeId currently being inline-edited
var editEl=null;    // the contenteditable element
var editOrig='';    // original text/markdown, for cancel/no-op revert
var richMode=false; // true when editing a richText node's markdown source
var editOrigHtml='';// original rendered innerHTML, to restore on cancel (rich)
var toolbar=null;   // floating markdown toolbar (rich)
var style=document.createElement('style');
style.textContent='.wb-ed-hover{outline:2px dashed #7c6ff0 !important;outline-offset:-2px}'+
'.wb-ed-selected{outline:2px solid #7c6ff0 !important;outline-offset:-2px}'+
'.wb-ed-editing{outline:2px solid #3ec2cc !important;outline-offset:-2px;cursor:text !important;white-space:pre-wrap}'+
'#wb-ed-toolbar{position:absolute;z-index:99999;display:flex;gap:2px;background:#222;border-radius:6px;padding:3px;box-shadow:0 4px 12px rgb(0 0 0/.35)}'+
'#wb-ed-toolbar button{background:#333;color:#fff;border:0;border-radius:4px;padding:3px 9px;font-size:13px;line-height:1.2;cursor:pointer}'+
'#wb-ed-toolbar button:hover{background:#555}'+
'#wb-ed-indicator{position:absolute;background:#7c6ff0;pointer-events:none;z-index:99999;border-radius:2px}'+
'.wb-ed-selected{cursor:grab}'+
'.wb-ed-dragging{opacity:.55 !important;cursor:grabbing !important}'+
'a,button{cursor:default !important}';
document.head.appendChild(style);
var indicator=document.createElement('div');
indicator.id='wb-ed-indicator';
indicator.style.display='none';
document.body.appendChild(indicator);
// Container node ids the editor considers valid drop parents (sent on load and
// whenever the tree changes). Used to hit-test in-canvas node dragging.
var containerIds=[];
// In-canvas drag-to-reorder state.
var dragCand=null;   // node id pressed, a drag candidate (past threshold → drag)
var dragEl=null;     // the element being dragged
var dragging=false;  // true once the pointer passed the start threshold
var dragSX=0,dragSY=0;
var dragTarget=null; // {containerId,index} under the pointer
var justDragged=false;// suppress the click that follows a drag

function nodeEl(el){return el&&el.closest?el.closest('[data-node-id]'):null}
// Preview and editor are same-origin; target the exact origin, never '*'.
function send(msg){parent.postMessage(msg,location.origin)}

document.addEventListener('click',function(e){
  // While editing, let clicks inside the editable place the caret normally.
  if(editing){var ce=nodeEl(e.target);if(ce&&ce.getAttribute('data-node-id')===editing)return}
  // A drag just ended on this element — swallow the synthetic click so it
  // doesn't re-select or deselect.
  if(justDragged){justDragged=false;e.preventDefault();e.stopPropagation();return}
  e.preventDefault();e.stopPropagation();
  var el=nodeEl(e.target);
  if(el){setSelected(el.getAttribute('data-node-id'));send({type:'wb:clicked',nodeId:el.getAttribute('data-node-id')})}
},true);
// Double-click asks the editor whether this node is inline-text-editable.
document.addEventListener('dblclick',function(e){
  var el=nodeEl(e.target);
  if(el){e.preventDefault();e.stopPropagation();send({type:'wb:dblclick',nodeId:el.getAttribute('data-node-id')})}
},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);

var hoverEl=null;
document.addEventListener('mousemove',function(e){
  if(editing)return;
  var el=nodeEl(e.target);
  if(hoverEl===el)return;
  if(hoverEl)hoverEl.classList.remove('wb-ed-hover');
  hoverEl=el;
  if(el&&el.getAttribute('data-node-id')!==selected)el.classList.add('wb-ed-hover');
});

// ── In-canvas drag-to-reorder ────────────────────────────────────────────────
// Press on the already-selected block and drag it to a new slot among valid
// containers. Pure editor chrome: on drop we emit a single move tree-op via the
// editor; the published output is untouched.
document.addEventListener('mousedown',function(e){
  // New gesture — clear any stale drag-suppression flag (a drag that ends over a
  // different element fires no click, so the flag wouldn't otherwise reset).
  justDragged=false;
  if(editing||e.button!==0)return;
  var el=nodeEl(e.target);
  // Only the currently-selected node is a drag handle (click-to-select first).
  if(!el||el.getAttribute('data-node-id')!==selected)return;
  dragCand=selected;dragEl=el;dragging=false;dragSX=e.clientX;dragSY=e.clientY;
},true);
document.addEventListener('mousemove',function(e){
  if(!dragCand||editing)return;
  if(!dragging){
    if(Math.abs(e.clientX-dragSX)+Math.abs(e.clientY-dragSY)<5)return;
    dragging=true;
    if(hoverEl){hoverEl.classList.remove('wb-ed-hover');hoverEl=null;}
    dragEl.classList.remove('wb-ed-selected','wb-ed-hover');
    dragEl.classList.add('wb-ed-dragging');
  }
  e.preventDefault();
  dragHittest(e.clientX,e.clientY);
},true);
document.addEventListener('mouseup',function(e){
  if(!dragCand)return;
  var wasDragging=dragging,node=dragCand,tgt=dragTarget;
  dragCand=null;dragging=false;dragTarget=null;
  indicator.style.display='none';
  if(dragEl){dragEl.classList.remove('wb-ed-dragging');}
  dragEl=null;
  if(!wasDragging)return;
  justDragged=true; // suppress the trailing click
  e.preventDefault();e.stopPropagation();
  if(tgt&&tgt.containerId){
    send({type:'wb:move-node',nodeId:node,containerId:tgt.containerId,index:tgt.index});
  }
},true);

// Like hittest, but for moving an existing node: skip the dragged node and any
// container inside its own subtree (can't drop a node into itself).
function dragHittest(x,y){
  indicator.style.display='none';dragTarget=null;
  var el=document.elementFromPoint(x,y);
  var target=nodeEl(el);
  while(target&&(containerIds.indexOf(target.getAttribute('data-node-id'))===-1||(dragEl&&dragEl.contains(target)))){
    target=nodeEl(target.parentElement);
  }
  if(!target)return;
  var containerId=target.getAttribute('data-node-id');
  var kids=[].filter.call(target.querySelectorAll('[data-node-id]'),function(k){return nodeEl(k.parentElement)===target});
  var index=kids.length;
  for(var j=0;j<kids.length;j++){
    var r=kids[j].getBoundingClientRect();
    if(y<r.top+r.height/2){index=j;break}
  }
  var rect;
  if(kids.length===0){var tr=target.getBoundingClientRect();rect={left:tr.left+4,top:tr.top+4,width:tr.width-8,height:4};}
  else if(index>=kids.length){var lr=kids[kids.length-1].getBoundingClientRect();rect={left:lr.left,top:lr.bottom+2,width:lr.width,height:4};}
  else{var nr=kids[index].getBoundingClientRect();rect={left:nr.left,top:nr.top-4,width:nr.width,height:4};}
  indicator.style.display='block';
  indicator.style.left=(rect.left+scrollX)+'px';
  indicator.style.top=(rect.top+scrollY)+'px';
  indicator.style.width=rect.width+'px';
  indicator.style.height=rect.height+'px';
  dragTarget={containerId:containerId,index:index};
}

function setSelected(nodeId){
  if(selected){var prev=document.querySelector('[data-node-id="'+selected+'"]');if(prev)prev.classList.remove('wb-ed-selected')}
  selected=nodeId;
  if(!nodeId)return;
  var el=document.querySelector('[data-node-id="'+nodeId+'"]');
  if(el){el.classList.remove('wb-ed-hover');el.classList.add('wb-ed-selected')}
}

function beginEdit(nodeId,rich,source){
  finishEdit(false); // close any prior edit first
  var el=nodeId&&document.querySelector('[data-node-id="'+nodeId+'"]');
  if(!el)return;
  setSelected(nodeId);
  editing=nodeId;editEl=el;richMode=!!rich;
  el.classList.remove('wb-ed-selected','wb-ed-hover');
  el.classList.add('wb-ed-editing');
  if(rich){
    // Edit the markdown SOURCE in place (not the rendered HTML), with a toolbar.
    editOrigHtml=el.innerHTML;editOrig=source||'';
    el.style.whiteSpace='pre-wrap';
    el.textContent=source||'';
    showToolbar(el);
  }else{
    editOrig=el.textContent||'';
  }
  el.setAttribute('contenteditable','true');
  el.focus();
  var r=document.createRange();r.selectNodeContents(el);
  var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
}
function finishEdit(commit){
  if(!editing||!editEl)return;
  var nodeId=editing,el=editEl,orig=editOrig,rich=richMode,origHtml=editOrigHtml;
  editing=null;editEl=null;editOrig='';richMode=false;editOrigHtml='';
  hideToolbar();
  el.removeAttribute('contenteditable');
  el.classList.remove('wb-ed-editing');
  el.style.whiteSpace='';
  if(rich){
    // innerText preserves the line breaks the markdown needs.
    var md=(el.innerText||'').replace(/\\n{3,}/g,'\\n\\n').replace(/[ \\t]+$/gm,'').trim();
    if(commit&&md&&md!==orig.trim()){send({type:'wb:text-commit',nodeId:nodeId,text:md})}
    else{el.innerHTML=origHtml;setSelected(nodeId)}
  }else{
    var text=(el.textContent||'').replace(/\\s+/g,' ').trim();
    var was=orig.replace(/\\s+/g,' ').trim();
    if(commit&&text&&text!==was){send({type:'wb:text-commit',nodeId:nodeId,text:text})}
    else{el.textContent=orig;setSelected(nodeId)}
  }
}
function showToolbar(el){
  hideToolbar();
  toolbar=document.createElement('div');toolbar.id='wb-ed-toolbar';
  var defs=[['B','**','**'],['i','*','*'],['link','[','](https://)'],['• list','\\n- ','']];
  for(var i=0;i<defs.length;i++){(function(d){
    var b=document.createElement('button');b.type='button';b.textContent=d[0];
    // mousedown (not click) + preventDefault keeps the caret/selection in the editable.
    b.addEventListener('mousedown',function(ev){ev.preventDefault();wrapSelection(d[1],d[2])});
    toolbar.appendChild(b);
  })(defs[i])}
  document.body.appendChild(toolbar);
  var rect=el.getBoundingClientRect();
  toolbar.style.left=(rect.left+scrollX)+'px';
  toolbar.style.top=Math.max(0,rect.top+scrollY-38)+'px';
}
function hideToolbar(){if(toolbar){toolbar.remove();toolbar=null}}
function wrapSelection(before,after){
  var sel=window.getSelection();
  if(!sel.rangeCount||!editEl)return;
  var range=sel.getRangeAt(0);
  if(!editEl.contains(range.commonAncestorContainer))return;
  var chosen=range.toString();
  var node=document.createTextNode(before+(chosen||'text')+(after||''));
  range.deleteContents();range.insertNode(node);
  range.setStartAfter(node);range.collapse(true);
  sel.removeAllRanges();sel.addRange(range);
  editEl.focus();
}
document.addEventListener('keydown',function(e){
  if(!editing)return;
  if(e.key==='Escape'){e.preventDefault();finishEdit(false);return}
  // Rich (markdown) editing is multi-line — Enter inserts a newline, doesn't commit.
  if(!richMode&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();finishEdit(true)}
},true);
document.addEventListener('blur',function(e){
  if(editing&&editEl&&e.target===editEl)finishEdit(true);
},true);

function hittest(x,y,containerIds){
  indicator.style.display='none';
  var el=document.elementFromPoint(x,y);
  var target=nodeEl(el);
  while(target&&containerIds.indexOf(target.getAttribute('data-node-id'))===-1){
    target=nodeEl(target.parentElement);
  }
  if(!target){send({type:'wb:drop-target',containerId:null});return}
  var containerId=target.getAttribute('data-node-id');
  var kids=[].filter.call(target.querySelectorAll('[data-node-id]'),function(k){return nodeEl(k.parentElement)===target});
  var index=kids.length;
  for(var j=0;j<kids.length;j++){
    var r=kids[j].getBoundingClientRect();
    if(y<r.top+r.height/2){index=j;break}
  }
  var rect;
  if(kids.length===0){
    var tr=target.getBoundingClientRect();
    rect={left:tr.left+4,top:tr.top+4,width:tr.width-8,height:4};
  }else if(index>=kids.length){
    var lr=kids[kids.length-1].getBoundingClientRect();
    rect={left:lr.left,top:lr.bottom+2,width:lr.width,height:4};
  }else{
    var nr=kids[index].getBoundingClientRect();
    rect={left:nr.left,top:nr.top-4,width:nr.width,height:4};
  }
  indicator.style.display='block';
  indicator.style.left=(rect.left+scrollX)+'px';
  indicator.style.top=(rect.top+scrollY)+'px';
  indicator.style.width=rect.width+'px';
  indicator.style.height=rect.height+'px';
  send({type:'wb:drop-target',containerId:containerId,index:index});
}

addEventListener('message',function(e){
  if(e.origin!==location.origin)return; // ignore cross-origin senders
  var d=e.data||{};
  if(d.type==='wb:select-node'){
    setSelected(d.nodeId);
    var el=d.nodeId&&document.querySelector('[data-node-id="'+d.nodeId+'"]');
    if(el)el.scrollIntoView({block:'nearest',behavior:'smooth'});
  }else if(d.type==='wb:hittest'){
    hittest(d.x,d.y,d.containerIds||[]);
  }else if(d.type==='wb:clear-indicator'){
    indicator.style.display='none';
  }else if(d.type==='wb:set-containers'){
    containerIds=d.containerIds||[];
  }else if(d.type==='wb:edit-begin'){
    beginEdit(d.nodeId,d.rich,d.text);
  }
});
send({type:'wb:ready'});
})();`;

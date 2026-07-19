/**
 * Editor-mode script injected into preview pages when the visual editor loads
 * them in its canvas iframe (?editor=1). Never part of published output.
 *
 * Protocol (window.postMessage with the parent editor):
 *  in:  {type:'wb:select-node', nodeId}            → outline + scroll to node
 *  in:  {type:'wb:hittest', x, y, containerIds}    → find drop target under point
 *  in:  {type:'wb:clear-indicator'}
 *  out: {type:'wb:ready'}
 *  out: {type:'wb:clicked', nodeId}
 *  out: {type:'wb:drop-target', containerId, index, rect:{...}}
 */
export const EDITOR_PREVIEW_JS = `(function(){
var selected=null;
var style=document.createElement('style');
style.textContent='.wb-ed-hover{outline:2px dashed #7c6ff0 !important;outline-offset:-2px}'+
'.wb-ed-selected{outline:2px solid #7c6ff0 !important;outline-offset:-2px}'+
'#wb-ed-indicator{position:absolute;background:#7c6ff0;pointer-events:none;z-index:99999;border-radius:2px}'+
'a,button{cursor:default !important}';
document.head.appendChild(style);
var indicator=document.createElement('div');
indicator.id='wb-ed-indicator';
indicator.style.display='none';
document.body.appendChild(indicator);

function nodeEl(el){return el&&el.closest?el.closest('[data-node-id]'):null}
function send(msg){parent.postMessage(msg,'*')}

document.addEventListener('click',function(e){
  e.preventDefault();e.stopPropagation();
  var el=nodeEl(e.target);
  if(el){setSelected(el.getAttribute('data-node-id'));send({type:'wb:clicked',nodeId:el.getAttribute('data-node-id')})}
},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);

var hoverEl=null;
document.addEventListener('mousemove',function(e){
  var el=nodeEl(e.target);
  if(hoverEl===el)return;
  if(hoverEl)hoverEl.classList.remove('wb-ed-hover');
  hoverEl=el;
  if(el&&el.getAttribute('data-node-id')!==selected)el.classList.add('wb-ed-hover');
});

function setSelected(nodeId){
  if(selected){var prev=document.querySelector('[data-node-id="'+selected+'"]');if(prev)prev.classList.remove('wb-ed-selected')}
  selected=nodeId;
  if(!nodeId)return;
  var el=document.querySelector('[data-node-id="'+nodeId+'"]');
  if(el){el.classList.remove('wb-ed-hover');el.classList.add('wb-ed-selected')}
}

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
  var d=e.data||{};
  if(d.type==='wb:select-node'){
    setSelected(d.nodeId);
    var el=d.nodeId&&document.querySelector('[data-node-id="'+d.nodeId+'"]');
    if(el)el.scrollIntoView({block:'nearest',behavior:'smooth'});
  }else if(d.type==='wb:hittest'){
    hittest(d.x,d.y,d.containerIds||[]);
  }else if(d.type==='wb:clear-indicator'){
    indicator.style.display='none';
  }
});
send({type:'wb:ready'});
})();`;

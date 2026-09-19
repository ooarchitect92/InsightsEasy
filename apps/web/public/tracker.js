/* InsightsEasy first-party collector v1. Consent must be granted before any storage/network use. */
(function(root){'use strict';
 root.InsightsEasyTracker=function(options){
  if(!options||!options.sourceId||!options.endpoint)throw new Error('sourceId and endpoint are required');
  var permitted=false,visitor=null,active=new Set(),storageKey='ie-visitor-'+options.sourceId;
  var endpoint=new URL(options.endpoint,root.location.href);
  if(!['https:','http:'].includes(endpoint.protocol))throw new Error('Invalid collector endpoint');
  function track(){
   if(!permitted)return Promise.resolve({state:'consent_denied'});
   var url=new URL(root.location.href),ref;
   try{if(document.referrer){ref=new URL(document.referrer);ref.search='';ref.hash='';}}catch{/* Optional storage/referrer unavailable. */}
   var acquisition={url:url.origin+url.pathname};if(ref)acquisition.referrer=ref.href;
   [['utm_source','utmSource'],['utm_medium','utmMedium'],['utm_campaign','utmCampaign']].forEach(function(pair){var v=url.searchParams.get(pair[0]);if(v)acquisition[pair[1]]=v.slice(0,100);});
   ['gclid','gbraid','wbraid','fbclid'].some(function(k){var v=url.searchParams.get(k);if(v){acquisition.clickId={type:k,value:v.slice(0,256)};return true;}return false;});
   var event={kind:'touch',eventId:crypto.randomUUID(),visitorId:visitor,occurredAt:new Date().toISOString(),analyticsConsent:true,acquisition:acquisition};
   var raw=JSON.stringify(event),controller=new AbortController();active.add(controller);
   async function send(){for(var attempt=0;attempt<3;attempt++){
    if(!permitted)return {state:'consent_denied'};
    try{var response=await fetch(endpoint.href.replace(/\/$/,'')+'/'+encodeURIComponent(options.sourceId),{method:'POST',headers:{'content-type':'application/json'},body:raw,credentials:'omit',signal:controller.signal,redirect:'error'});
     if(response.ok)return await response.json();if(response.status<500&&response.status!==429)return {state:'rejected',status:response.status};
    }catch(error){if(controller.signal.aborted)return {state:'cancelled'};if(attempt===2)throw error;}
    await new Promise(function(resolve){setTimeout(resolve,500*Math.pow(2,attempt));});
   }return {state:'unavailable'};}
   return send().finally(function(){active.delete(controller);});
  }
  return {grant:function(){if(permitted)return Promise.resolve({state:'already_granted'});permitted=true;
    try{visitor=sessionStorage.getItem(storageKey);}catch{/* Optional storage/referrer unavailable. */}
    if(!visitor||!/^[A-Za-z0-9_-]{1,128}$/.test(visitor)){visitor=crypto.randomUUID();try{sessionStorage.setItem(storageKey,visitor);}catch{/* Optional storage/referrer unavailable. */}}
    return track();},track:track,revoke:function(){permitted=false;active.forEach(function(c){c.abort();});active.clear();visitor=null;try{sessionStorage.removeItem(storageKey);}catch{/* Optional storage/referrer unavailable. */}},
    visitorReference:function(){return permitted?visitor:null;}};
 };
})(window);

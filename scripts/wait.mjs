const urls=process.argv.slice(2);const until=Date.now()+180000;
for(const url of urls){let success=false;while(Date.now()<until){try{const r=await fetch(url,{signal:AbortSignal.timeout(3000)});if(r.ok){success=true;break;}}catch{/* not ready */}await new Promise(r=>setTimeout(r,1000));}if(!success)throw new Error('Readiness deadline exceeded: '+url);console.log('Ready: '+url);}

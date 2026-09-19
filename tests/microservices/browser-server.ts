import {createHarness} from './harness.ts';
const h=await createHarness(4000);let active:Promise<void>|undefined;
const timer=setInterval(()=>{if(!active)active=h.drain().catch(e=>console.error(e instanceof Error?e.message:'harness error')).finally(()=>{active=undefined;});},200);
console.log('COMPONENT TEST HARNESS: real HTTP, isolated test stores, no Kafka/RabbitMQ/Redis.');
const stop=async()=>{clearInterval(timer);await active;await h.close();};process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());

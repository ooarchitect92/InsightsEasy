const control=process.env.GATEWAY_ORIGIN??process.env.CONTROL_ORIGIN??'http://gateway:4000';
const ingest=process.env.GATEWAY_ORIGIN??process.env.INGEST_ORIGIN??'http://gateway:4000';
/** @type {import('next').NextConfig} */
export default {
  output:'standalone', poweredByHeader:false,
  async rewrites(){return [
    {source:'/api/ingest/:path*',destination:`${ingest}/:path*`},
    {source:'/api/:path*',destination:`${control}/:path*`}
  ];},
  async headers(){return [{source:'/:path*',headers:[
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
    {key:'X-Frame-Options',value:'DENY'},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}
  ]}];}
};

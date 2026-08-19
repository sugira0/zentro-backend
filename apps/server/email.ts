import { createTransport } from 'nodemailer'

// Every SMTP_* var is optional so the app keeps working without email configured
// (e.g. local dev) — sends are logged and skipped rather than throwing.
const config=()=>{
 const host=process.env.SMTP_HOST,port=Number(process.env.SMTP_PORT||587),user=process.env.SMTP_USER,pass=process.env.SMTP_PASS,from=process.env.SMTP_FROM||user
 if(!host||!user||!pass)return null
 return{host,port,secure:process.env.SMTP_SECURE==='true'||port===465,auth:{user,pass},from}
}

let transporter=null,transporterConfig=null
function getTransporter(){
 const current=config()
 if(!current)return null
 if(!transporter||JSON.stringify(current)!==JSON.stringify(transporterConfig)){transporter=createTransport(current);transporterConfig=current}
 return transporter
}

export async function sendEmail({to,subject,text,html}){
 const current=config()
 if(!current){console.log(`[email] SMTP not configured — skipped "${subject}" to ${to}`);return{sent:false,reason:'SMTP not configured'}}
 const mailer=getTransporter()
 try{
  await mailer.sendMail({from:current.from,to,subject,text,html:html||undefined})
  return{sent:true}
 }catch(error){
  console.error('[email] Send failed',error)
  return{sent:false,reason:error instanceof Error?error.message:'Send failed'}
 }
}

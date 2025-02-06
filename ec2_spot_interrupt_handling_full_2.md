
# **📌 จำลองเหตุการณ์: EC2 Spot Instance ถูกดึงคืน (Interrupt) และต้องการให้ได้ Private IP เดิม พร้อมรักษา EBS ทั้งหมด**

---

## **💡 สถานการณ์สมมติ**

- **EC2 Spot Instance (Windows Server) ใช้ Private Subnet ไม่มี Public IP**
- **Instance นี้ Join กับ DNS Windows (Active Directory หรือ Custom DNS)**
- **EC2 ใช้ EBS หลายตัว:**
    - **EBS Root Volume** → เก็บ OS และ Configuration (`C:\`)
    - **EBS Secondary Volume** → เก็บข้อมูลธุรกิจ (`D:\`)
- **ต้องการให้:**
    - Private IP เดิมไม่เปลี่ยน (DNS Windows ยังคงใช้งานได้)
    - หาก Instance ถูกดึงคืน ให้กลับมาใหม่อัตโนมัติ
    - EBS ทั้งหมดถูกแนบกลับมาให้เหมือนเดิม

---

## **🚀 เมื่อ AWS เรียกคืน (Interrupt) Spot Instance**

AWS สามารถ Interruption ได้ 3 รูปแบบ ได้แก่ **Stop**, **Hibernate**, และ **Terminate**  
ผลกระทบต่อ **Private IP, RAM, และ EBS** จะแตกต่างกันไป

| **Interruption Type** | **EBS Root (OS)** | **EBS Secondary (Data)** | **RAM หายไหม?** | **Private IP เปลี่ยนไหม?** | **กลับมาอัตโนมัติไหม?** |
|----------------------|------------------|------------------|----------------|-----------------|-----------------|
| **Stop (หยุดชั่วคราว)** | ✅ ยังอยู่ | ✅ ยังอยู่ | ✅ หาย | ✅ เปลี่ยน | ❌ ต้อง Start เอง |
| **Hibernate (จำศีล)** | ✅ ยังอยู่ | ✅ ยังอยู่ | ❌ ไม่หาย | ✅ เปลี่ยน | ✅ กลับมาต่อเอง |
| **Terminate (ลบทิ้ง)** | ✅ อาจถูกลบ (ถ้า `DeleteOnTermination=true`) | ✅ ยังอยู่ (ถ้า `DeleteOnTermination=false`) | ✅ หาย | ✅ เปลี่ยน | ✅ ถ้าใช้ Auto Scaling |

---

## **✅ เหตุการณ์ที่ 1: AWS เรียกคืน (Interrupt) EC2 Spot Instance และใช้ Stop**

### **🔹 สิ่งที่เกิดขึ้น**
1. **Instance จะถูกปิด (Stop)**
2. **EBS Root และ Secondary Volume ยังคงอยู่**
3. **RAM และ Session ทั้งหมดหาย**
4. **Private IP เปลี่ยน**
5. **ต้อง Start Instance เอง (AWS ไม่เปิดให้อัตโนมัติ)**

### **🔹 วิธีแก้ไขให้ Instance ได้ Private IP เดิม**
📌 **ใช้ Elastic Network Interface (ENI) แยกออกมาเพื่อจอง Private IP**
```bash
aws ec2 create-network-interface --subnet-id subnet-xxxxxxxx --private-ip-address 10.0.1.100
```
```bash
aws ec2 attach-network-interface --network-interface-id eni-xxxxxxxx --instance-id i-xxxxxxxx
```
```bash
aws ec2 start-instances --instance-ids i-xxxxxxxx
```
✅ **EBS ไม่หาย**  
✅ **Windows AD ยังอยู่ แต่ต้อง Re-Join DNS**  
❌ **ต้อง Attach ENI เองทุกครั้งที่ Start ใหม่**  
❌ **Private IP เปลี่ยน หากไม่ใช้ ENI**  

---

## **✅ เหตุการณ์ที่ 2: AWS เรียกคืน (Interrupt) EC2 Spot Instance และใช้ Hibernate**
### **🔹 สิ่งที่เกิดขึ้น**
1. **Instance หยุดทำงานแบบ Hibernate**
2. **EBS (Root + Secondary) ยังคงอยู่ และ RAM ยังคงอยู่**
3. **Windows ไม่ต้อง Reboot ใหม่**
4. **Private IP เปลี่ยน (เว้นแต่ใช้ ENI)**
5. **DNS ต้องอัปเดตให้ชี้ไปที่ Private IP ใหม่**

### **🔹 วิธีแก้ไขให้ Windows AD & DNS ใช้งานต่อได้**
📌 **ใช้ ENI ที่จอง Private IP เดิม**
```bash
aws ec2 create-network-interface --subnet-id subnet-xxxxxxxx --private-ip-address 10.0.1.100
```
```bash
aws ec2 attach-network-interface --network-interface-id eni-xxxxxxxx --instance-id i-xxxxxxxx
```
```bash
aws ec2 describe-network-interfaces --network-interface-id eni-xxxxxxxx
```

✅ **RAM และ Process ไม่หาย กลับมาทำงานต่อได้เลย**  
✅ **Windows AD ไม่ต้อง Re-Join**  
✅ **สามารถใช้ Private IP เดิมถ้าใช้ ENI**  
❌ **ใช้ได้เฉพาะบาง Instance Types เช่น t3.medium, m5.large เท่านั้น**  

---

## **✅ เหตุการณ์ที่ 3: AWS เรียกคืน (Interrupt) EC2 Spot Instance และใช้ Terminate**
### **🔹 สิ่งที่เกิดขึ้น**
1. **AWS ลบ EC2 Spot Instance ทิ้ง**
2. **EBS Root อาจถูกลบ (ถ้า `DeleteOnTermination=true`)**
3. **EBS Secondary ยังอยู่ (ถ้าตั้งค่า `DeleteOnTermination=false`)**
4. **Private IP เปลี่ยน**
5. **Windows AD ต้อง Re-Join ใหม่**
6. **ต้องสร้าง EC2 ใหม่และ Attach EBS + ENI กลับเอง**

### **🔹 วิธีคืนค่าระบบให้เหมือนเดิมอัตโนมัติ**
📌 **ใช้ Auto Scaling Group (ASG) + Launch Template + ENI**
```bash
aws autoscaling create-auto-scaling-group   --auto-scaling-group-name my-spot-asg   --launch-template LaunchTemplateId=lt-xxxxxxxxxxxxx,Version=$Latest   --min-size 1 --max-size 3 --desired-capacity 1   --vpc-zone-identifier "subnet-xxxxxxxx"
```
```bash
aws ec2 create-network-interface --subnet-id subnet-xxxxxxxx --private-ip-address 10.0.1.100
aws ec2 attach-network-interface --network-interface-id eni-xxxxxxxx --instance-id i-yyyyyyyy
```

✅ **ระบบสามารถสร้างใหม่อัตโนมัติได้เมื่อ Spot Instance ถูกลบ**  
✅ **สามารถใช้ Private IP เดิมถ้าใช้ ENI**  
❌ **ต้องรอ Instance ใหม่สร้างขึ้นมา**  
❌ **Windows AD อาจต้อง Re-Join**  

---

## **📌 สรุปวิธีดัก Event การ Interrupt ของ Spot Instance และส่ง Email**
| **ขั้นตอน** | **เครื่องมือที่ใช้** | **ผลลัพธ์** |
|------------|------------------|------------|
| 1️⃣ สร้าง SNS Topic | **AWS SNS** | ใช้เป็น Notification Hub สำหรับส่ง Email |
| 2️⃣ สร้าง EventBridge Rule | **AWS EventBridge** | ดักจับ `"EC2 Spot Instance Interruption Warning"` |
| 3️⃣ ผูก SNS กับ EventBridge | **AWS EventBridge + SNS** | เมื่อมี Spot Instance Interrupt → ส่ง Email ทันที |
| 4️⃣ (Optional) ใช้ Lambda | **AWS Lambda** | ปรับแต่งข้อมูลก่อนส่ง Email |

✅ **เมื่อ AWS Interruption (Stop, Hibernate, Terminate) Spot Instance → ระบบจะส่ง Email อัตโนมัติภายในไม่กี่วินาที!** 🚀

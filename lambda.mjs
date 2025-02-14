import { EC2Client, DescribeInstancesCommand , DescribeVolumesCommand , DescribeSnapshotsCommand } from "@aws-sdk/client-ec2";
import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { S3Client, ListBucketsCommand, PutObjectCommand , GetBucketTaggingCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand , GetCallerIdentityCommand} from "@aws-sdk/client-sts";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand , DescribeTagsCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { parse } from "json2csv";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const currentRegion = process.env.AWS_REGION || process.env.region;
console.log(`Current AWS Region: ${currentRegion}`);

const ec2Client = new EC2Client({ region: currentRegion });
const rdsClient = new RDSClient({ region: currentRegion });
const s3Client = new S3Client({ region: currentRegion });
const stsClient = new STSClient({ region: currentRegion });
const elbClient = new ElasticLoadBalancingV2Client({ region: currentRegion });
const snsClient = new SNSClient({ region: currentRegion});

const accountNames = JSON.parse(process.env.account_names);

export const handler = async (event) => {
    try {
        const currentAccountId = await getAccountId() ;
        const listOtherAccountsToGenerateData = JSON.parse(process.env.other_accounts_gen_report);

        // Generate EC2 inventory for all accounts
        const ec2Instances = [
            ...await getEc2List(ec2Client)
        ];

        // Generate RDS inventory for all accounts
        const rdsInstances = [
            ...await getRdsList(rdsClient)
        ];

        // Generate S3 inventory for all accounts
        const s3Buckets = [
            ...await getS3List(s3Client, currentAccountId)
        ];

        // Generate EBS inventory for all accounts
        const ebsVolumes = [
            ...await getEbsList(ec2Client, currentAccountId)
        ];

        // Generate EBS snapshots for all accounts
        const ebsSnapshots = [
            ...await getEbsSnapshots(ec2Client, currentAccountId)
        ];

        // Generate Load Balancer inventory for all accounts
        const loadBalancers = [
            ...await getLoadBalancers(elbClient, currentAccountId)
        ];
    
        for (const accountId of listOtherAccountsToGenerateData) {
            const assumedRole = await assumeRole(accountId);
            const ec2ClientOtherAccount = new EC2Client({
                region: currentRegion,
                credentials: {
                    accessKeyId: assumedRole.Credentials.AccessKeyId,
                    secretAccessKey: assumedRole.Credentials.SecretAccessKey,
                    sessionToken: assumedRole.Credentials.SessionToken
                }
            });
            const rdsClientOtherAccount = new RDSClient({
                region: currentRegion,
                credentials: {
                    accessKeyId: assumedRole.Credentials.AccessKeyId,
                    secretAccessKey: assumedRole.Credentials.SecretAccessKey,
                    sessionToken: assumedRole.Credentials.SessionToken
                }
            });
            const s3ClientOtherAccount = new S3Client({
                region: currentRegion,
                credentials: {
                    accessKeyId: assumedRole.Credentials.AccessKeyId,
                    secretAccessKey: assumedRole.Credentials.SecretAccessKey,
                    sessionToken: assumedRole.Credentials.SessionToken
                }
            });
            const elbClientOtherAccount = new ElasticLoadBalancingV2Client({
                region: currentRegion,
                credentials: {
                    accessKeyId: assumedRole.Credentials.AccessKeyId,
                    secretAccessKey: assumedRole.Credentials.SecretAccessKey,
                    sessionToken: assumedRole.Credentials.SessionToken
                }
            });
            ec2Instances.push(...await getEc2List(ec2ClientOtherAccount));
            rdsInstances.push(...await getRdsList(rdsClientOtherAccount));
            s3Buckets.push(...await getS3List(s3ClientOtherAccount, accountId));
            ebsVolumes.push(...await getEbsList(ec2ClientOtherAccount, accountId));
            ebsSnapshots.push(...await getEbsSnapshots(ec2ClientOtherAccount, accountId));
            loadBalancers.push(...await getLoadBalancers(elbClientOtherAccount, accountId));
        }

        const ec2ReportPath = "ec2/ec2-instances-" + new Date().getTime() + ".csv";
        const rdsReportPath = "rds/rds-instances-" + new Date().getTime() + ".csv";
        const s3ReportPath = "s3/s3-buckets-" + new Date().getTime() + ".csv";
        const ebsVolumesReportPath = "ebs/ebs-volumes-" + new Date().getTime() + ".csv";
        const ebsSnapshotsReportPath = "ebs-snapshot/ebs-snapshots-" + new Date().getTime() + ".csv";
        const loadBalancersReportPath = "load-balancer/load-balancer-" + new Date().getTime() + ".csv";

        await generateReport(ec2Instances, ec2ReportPath);
        await generateReport(rdsInstances, rdsReportPath);
        await generateReport(s3Buckets, s3ReportPath);
        await generateReport(ebsVolumes,ebsVolumesReportPath);
        await generateReport(ebsSnapshots,ebsSnapshotsReportPath);
        await generateReport(loadBalancers, loadBalancersReportPath);

        const message = `
            S3 Bucket Name is : ${process.env.s3_export_bucket} , Account ID : ${currentAccountId} , AccountName : ${accountNames[currentAccountId] || "Unknown Account"}
            \n
            List of reports.
            \n
            EC2 Report: ${ec2ReportPath}
            RDS Report: ${rdsReportPath}
            S3 Report: ${s3ReportPath}
            EBS Volumes Report: ${ebsVolumesReportPath}
            EBS Snapshots Report: ${ebsSnapshotsReportPath}
            Load Balancers Report: ${loadBalancersReportPath}
        `;

        await publishMsgSns( message , "Export AWS Inventory Reports" );

    } catch (err) {
        console.error(err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};

async function assumeRole(accountId) {
    const command = new AssumeRoleCommand({
        RoleArn: "arn:aws:iam::" + accountId + ":role/dcp-svc-report-inventory-role",
        RoleSessionName: "AssumeRoleSession-" + new Date().getTime()
    });
    const data = await stsClient.send(command);
    return data;
}

async function getAccountId() {
    const command = new GetCallerIdentityCommand({});
    const data = await stsClient.send(command);
    return data.Account;
}

async function getEc2List(client) {
    const command = new DescribeInstancesCommand({});
    const data = await client.send(command);

    const instances = data.Reservations.flatMap(reservation =>
        reservation.Instances.map(instance => {
            const networkInterfaces = instance.NetworkInterfaces.map((ni, index) => ({
                [`NetworkInterfaceId#${index}`]: ni.NetworkInterfaceId
            }));
            const accountId = instance.IamInstanceProfile?.Arn.split(":")[4] || "";
            const accountName = accountNames[accountId] || "Unknown Account";

            return {
                "AccountID": accountId,
                "AccountName": accountName,
                "ResourceName": instance.Tags.find(tag => tag.Key === "Name")?.Value || "N/A",
                "Region": instance.Placement.AvailabilityZone.slice(0, -1),
                "ResourceType": instance.InstanceLifecycle || "Instance",
                "InstanceID": instance.InstanceId,
                "InstanceState": instance.State.Name,
                "InstanceType": instance.InstanceType,
                "LaunchTime": instance.LaunchTime,
                "PlatformDetails": instance.PlatformDetails || "N/A",
                ...Object.assign({}, ...networkInterfaces),
                "Public IPv4 DNS": instance.PublicDnsName || "N/A",
                "Public IPv4 address": instance.PublicIpAddress || "N/A",
                "Elastic IP": instance.ElasticGpuAssociations?.map(eip => eip.ElasticGpuId).join(", ") || "N/A",
                "IPv6 IPs": instance.Ipv6Address || "N/A",
                "Private IPs": instance.NetworkInterfaces.flatMap(ni => ni.PrivateIpAddresses.map(pip => pip.PrivateIpAddress)).join(", "),
                "VolumeAttachTime": instance.BlockDeviceMappings.map(bdm => bdm.Ebs.AttachTime).join(", "),
                "Security group name": instance.SecurityGroups.map(sg => sg.GroupName).join(", "),
                "All EBS Volume Id": instance.BlockDeviceMappings.map(bdm => bdm.Ebs.VolumeId).join(", "),
                ...Object.fromEntries(instance.Tags.map(tag => [ "Tag:"+ tag.Key, tag.Value]))
            };
        })
    );

    return instances;
}

async function getRdsList(client) {
    const command = new DescribeDBInstancesCommand({});
    const data = await client.send(command);

    const instances = data.DBInstances.map(instance => {
        const accountId = instance.DBInstanceArn.split(":")[4] || "";
        const accountName = accountNames[accountId] || "Unknown Account";

        const tags = instance.TagList.reduce((acc, tag) => {
            acc[`Tag:${tag.Key}`] = tag.Value;
            return acc;
        }, {});

        return {
            "AccountID": accountId,
            "AccountName": accountName,
            "ResourceName": instance.DBInstanceIdentifier,
            "Region": instance.AvailabilityZone.slice(0, -1),
            "ResourceType": "RDS Instance",
            "InstanceID": instance.DBInstanceIdentifier,
            "InstanceState": instance.DBInstanceStatus,
            "InstanceType": instance.DBInstanceClass,
            "LaunchTime": instance.InstanceCreateTime,
            "Engine": instance.Engine,
            "EngineVersion": instance.EngineVersion,
            "PubliclyAccessible": instance.PubliclyAccessible,
            "StorageType": instance.StorageType,
            "AllocatedStorage": instance.AllocatedStorage,
            "Endpoint": instance.Endpoint.Address,
            "Port": instance.Endpoint.Port,
            "MultiAZ": instance.MultiAZ,
            "BackupRetentionPeriod": instance.BackupRetentionPeriod,
            "DBName": instance.DBName || "N/A",
            "MasterUsername": instance.MasterUsername,
            "DBSecurityGroups": instance.DBSecurityGroups.map(sg => sg.DBSecurityGroupName).join(", "),
            "VpcSecurityGroups": instance.VpcSecurityGroups.map(sg => sg.VpcSecurityGroupId).join(", "),
            "DBParameterGroups": instance.DBParameterGroups.map(pg => pg.DBParameterGroupName).join(", "),
            "DBSubnetGroup": instance.DBSubnetGroup.DBSubnetGroupName,
            "PreferredBackupWindow": instance.PreferredBackupWindow,
            "PreferredMaintenanceWindow": instance.PreferredMaintenanceWindow,
            "IAMDatabaseAuthenticationEnabled": instance.IAMDatabaseAuthenticationEnabled,
            ...tags
        };
    });

    return instances;
}


async function getS3List(client , accountId) {
    const command = new ListBucketsCommand({});
    const data = await client.send(command);

    const buckets = await Promise.all(data.Buckets.map(async bucket => {
        const accountName = accountNames[accountId] || "Unknown Account";

        let tags = {};
        let size = 0;
        let lastAccess = null;
        let state = "Unknown";

        try {
            const tagCommand = new GetBucketTaggingCommand({ Bucket: bucket.Name });
            const tagData = await client.send(tagCommand);
            tags = tagData.TagSet.reduce((acc, tag) => {
                acc[`Tag:${tag.Key}`] = tag.Value;
                return acc;
            }, {});
        } catch (err) {
            console.log(`No tags found for bucket ${bucket.Name}`);
        }

        try {
            const headCommand = new HeadBucketCommand({ Bucket: bucket.Name });
            await client.send(headCommand);
            state = "Available";
        } catch (err) {
            state = "Not Available";
        }

        return {
            "AccountID": accountId,
            "AccountName": accountName,
            "BucketName": bucket.Name,
            "CreationDate": bucket.CreationDate,
            // "Size": size,
            "State": state,
            // "LastAccess": lastAccess,
            ...tags
        };
    }));

    return buckets;
}

async function getEbsList(client, accountId) {
    const command = new DescribeVolumesCommand({});
    const data = await client.send(command);

    const volumes = data.Volumes.map(volume => {
        const accountName = accountNames[accountId] || "Unknown Account";

        const tags = volume.Tags.reduce((acc, tag) => {
            acc[`Tag:${tag.Key}`] = tag.Value;
            return acc;
        }, {});

        return {
            "AccountID": accountId,
            "AccountName": accountName,
            "Name": volume.Tags.find(tag => tag.Key === "Name")?.Value || "N/A",
            "Volume ID": volume.VolumeId,
            "AvailabilityZone": volume.AvailabilityZone,
            "Type": volume.VolumeType,
            "Size": volume.Size,
            "IOPS": volume.Iops,
            "Throughput": volume.Throughput,
            "Snapshot ID": volume.SnapshotId || "N/A",
            "Created": volume.CreateTime,
            "Availability Zone": volume.AvailabilityZone,
            "Volume state": volume.State,
            "Alarm status": "N/A", // Placeholder, update with actual alarm status if available
            "Attached resources": volume.Attachments.map(att => att.InstanceId).join(", "),
            "Status check": "N/A", // Placeholder, update with actual status check if available
            "Encryption": volume.Encrypted,
            "KMS key ID": volume.KmsKeyId || "N/A",
            "Fast snapshot restored": volume.FastRestored,
            "Multi-Attach enabled": volume.MultiAttachEnabled,
            ...tags
        };
    });

    return volumes;
}

async function getEbsSnapshots(client, accountId) {
    const command = new DescribeSnapshotsCommand({
        OwnerIds: [accountId]
    });
    const data = await client.send(command);

    const snapshots = data.Snapshots.map(snapshot => {
        const accountName = accountNames[accountId] || "Unknown Account";

        const tags = snapshot.Tags ? snapshot.Tags.reduce((acc, tag) => {
            acc[`Tag:${tag.Key}`] = tag.Value;
            return acc;
        }, {}) : {};

        return {
            "AccountID": accountId,
            "AccountName": accountName,
            "Snapshot ID": snapshot.SnapshotId,
            "Volume ID": snapshot.VolumeId,
            "State": snapshot.State,
            "Start Time": snapshot.StartTime,
            "Progress": snapshot.Progress,
            "Owner ID": snapshot.OwnerId,
            "Description": snapshot.Description || "N/A",
            "Volume Size": snapshot.VolumeSize + " GB",
            "Storage Tier": snapshot.StorageTier || "N/A",
            "Encrypted": snapshot.Encrypted,
            "KMS Key ID": snapshot.KmsKeyId || "N/A",
            ...tags
        };
    });

    return snapshots;
}

async function getLoadBalancers(client, accountId) {
    const command = new DescribeLoadBalancersCommand({});
    const data = await client.send(command);

    const loadBalancers = await Promise.all(data.LoadBalancers.map(async lb => {
        const accountName = accountNames[accountId] || "Unknown Account";

        let tags = {};
        try {
            const tagCommand = new DescribeTagsCommand({ "ResourceArns": [lb.LoadBalancerArn] });
            const tagData = await client.send(tagCommand);
           
            tags = tagData.TagDescriptions.reduce((acc, tagDescription) => {
                tagDescription.Tags.forEach(tag => {
                    acc[`Tag:${tag.Key}`] = tag.Value;
                });
                return acc;
            }, {});
        } catch (err) {
            console.log(`No tags found for load balancer ${lb.LoadBalancerName}`);
        }

        return {
            "AccountID": accountId,
            "AccountName": accountName,
            "LoadBalancerArn": lb.LoadBalancerArn,
            "DNSName": lb.DNSName,
            "CanonicalHostedZoneId": lb.CanonicalHostedZoneId,
            "CreatedTime": lb.CreatedTime,
            "LoadBalancerName": lb.LoadBalancerName,
            "Scheme": lb.Scheme,
            "VpcId": lb.VpcId,
            "State": lb.State.Code,
            "Type": lb.Type,
            "IpAddressType": lb.IpAddressType,
            "SecurityGroups": lb.SecurityGroups ? lb.SecurityGroups.join(", ") : "N/A",
            "Subnets": lb.AvailabilityZones.map(az => az.SubnetId).join(", "),
            "AvailabilityZones": lb.AvailabilityZones.map(az => az.ZoneName).join(", "),
            ...tags
        };
    }));

    return loadBalancers;
}

async function publishMsgSns(message , subject){
    const params = {
        Message: message,
        Subject: subject,
        TopicArn: process.env.sns_arn
    };

    try {
        const data = await snsClient.send(new PublishCommand(params));
        console.log(`Message sent to the topic ${params.TopicArn}`);
        console.log("MessageID is " + data.MessageId);
    } catch (err) {
        console.error(err, err.stack);
    }
}

async function generateReport(instances, filePathName) {
    const csv = parse(instances, { delimiter: '|', header: true });
    const s3Params = {
        Bucket: process.env.s3_export_bucket,
        Key: filePathName,
        Body: csv,
        ContentType: "text/csv"
    };

    const putCommand = new PutObjectCommand(s3Params);
    await s3Client.send(putCommand);
}

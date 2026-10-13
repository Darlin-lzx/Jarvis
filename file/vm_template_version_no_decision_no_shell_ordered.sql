-- Simplified workflow with execution-ordered, evenly spaced coordinates.
INSERT INTO aif_comframe.vm_template_version (template_version_id,order_num,template_tag,create_staff_id,create_date,modify_desc,valid_date,expire_date,"content",content1,content2,content3,content4,content5,content6,content7,content8,content9,content10,content11,content12,content13,content14,content15) VALUES
	(1789959874520,5,'com.ai.order.workflow.shedule.vm.DefaultGsmYdkjNewWFSchedule','103747','2026-10-09 19:36:10.000','紧凑中轴等距布局','2026-10-09 00:00:00.000','2099-12-31 00:00:00.000',
'<?xml version="1.0" encoding="GBK" ?>
<workflow label="" tasktype="workflow" tasktag="com.ai.order.workflow.shedule.vm.DefaultGsmYdkjNewWFSchedule" duration="" isusemq="true" owntype="CSF">
    <description />
    <vars name="_TASK_JUGE_RESULT" datatype="java.lang.String" inouttype="inner" description="判断节点结果" />
    <vars name="custOrderId" datatype="java.lang.String" inouttype="inner" />
    <vars name="scheduleType" datatype="java.lang.String" inouttype="inner" />
    <task id="1" label="开始节点" tasktype="csf_start" tasktag="">
        <uiinfo>{"x":505,"y":60}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode />
            <servicecode />
            <servicename />
        </autodeal>
        <gotoitem goto="1790215737919" />
    </task>
    <task id="2" label="结束节点" tasktype="csf_finish" tasktag="">
        <uiinfo>{"x":505,"y":1028}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode />
            <servicecode />
            <servicename />
        </autodeal>
    </task>
    <task id="1790215737919" label="Fork" tasktype="fork" tasktag="">
        <uiinfo>{"x":505,"y":148}</uiinfo>
        <gotoitem goto="1790216116185" />
        <gotoitem goto="1790216253182" />
        <gotoitem goto="1790216330779" />
        <gotoitem goto="1790216397556" />
    </task>
    <task id="1790216116185" label="智家上门服务处理流程_订单处理" tasktype="csf_service" tasktag="smartHomeDoorService_dealOrder">
        <uiinfo>{"x":120,"y":221}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
                <link name="IN">
                    <left>vmTaskId</left>
                    <right>$TASK_ID</right>
                </link>
                <link name="OUT">
                    <left>return</left>
                    <right>$IS_WAIT_USER</right>
                </link>
                <link name="IN">
                    <left>scheduleType</left>
                    <right>scheduleType</right>
                    <defaultValue dataType="java.lang.String">BROADBAND_WIFI_NET_VAS</defaultValue>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="1790216516296" />
    </task>
    <task id="1790216253182" label="看家上门服务处理流程_订单处理" tasktype="csf_service" tasktag="ydkjDoorService_dealOrder">
        <uiinfo>{"x":800,"y":221}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
                <link name="IN">
                    <left>vmTaskId</left>
                    <right>$TASK_ID</right>
                </link>
                <link name="OUT">
                    <l',
'eft>return</left>
                    <right>$IS_WAIT_USER</right>
                </link>
                <link name="IN">
                    <left>scheduleType</left>
                    <right>scheduleType</right>
                    <defaultValue dataType="java.lang.String">YDKJ_INSTALL_VAS</defaultValue>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="1790216330779" />
        <gotoitem goto="1790216397556" />
        <gotoitem goto="1790216516296" />
    </task>
    <task id="1790216330779" label="云存储处理流程_订单处理" tasktype="csf_service" tasktag="cloudStorageService_dealOrder">
        <uiinfo>{"x":800,"y":309}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
                <link name="IN">
                    <left>vmTaskId</left>
                    <right>$TASK_ID</right>
                </link>
                <link name="OUT">
                    <left>return</left>
                    <right>$IS_WAIT_USER</right>
                </link>
                <link name="IN">
                    <left>scheduleType</left>
                    <right>scheduleType</right>
                    <defaultValue dataType="java.lang.String">NORMAL_CREATE_VAS_NP</defaultValue>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="1790216397556" />
        <gotoitem goto="1790216516296" />
    </task>
    <task id="1790216397556" label="移动看家变更流程_订单处理" tasktype="csf_service" tasktag="ydkjChange_dealOrder">
        <uiinfo>{"x":800,"y":397}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
                <link name="IN">
                    <left>vmTaskId</left>
                    <right>$TASK_ID</right>
                </link>
                <link name="OUT">
                    <left>return</left>
                    <right>$IS_WAIT_USER</right>
                </link>
                <link name="IN">
                    <left>scheduleType</left>
                    <right>scheduleType</right>
                    <defaultValue dataType="java.lang.String">YDKJ_CHANGE_MAIN</defaultValue>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="1790216516296" />
    </task>
    <task id="1790216516296" label="AND" tasktype="and" tasktag="">
        <uiinfo>{"x":505,"y":500}</uiinfo>
        <gotoitem goto="1790220539112" />
        <gotoitem goto="1790220704715" />
        <gotoitem goto="1790220802326" />
        <gotoitem goto="1790220850257" />
        <gotoitem goto="1790220990229" />
    </task>
    <task id="1790220539112" label="增值策划订购/退订流程_订单处理" tasktype="csf_service" tasktag="_dealOrder">
        <uiinfo>{"x":460,"y":573}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
   ',
'         <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
                <link name="IN">
                    <left>vmTaskId</left>
                    <right>$TASK_ID</right>
                </link>
                <link name="OUT">
                    <left>return</left>
                    <right>$IS_WAIT_USER</right>
                </link>
                <link name="IN">
                    <left>scheduleType</left>
                    <right>scheduleType</right>
                    <defaultValue dataType="java.lang.String">NORMAL_CREATE_VAS</defaultValue>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="1790220704715" />
        <gotoitem goto="1790220802326" />
        <gotoitem goto="1790220850257" />
        <gotoitem goto="1790220990229" />
    </task>
    <task id="1790220704715" label="增值策划订购流程_订单处理" tasktype="csf_service" tasktag="_dealOrder">
        <uiinfo>{"x":460,"y":661}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <gotoitem goto="1790220802326" />
        <gotoitem goto="1790220850257" />
        <gotoitem goto="1790220990229" />
    </task>
    <task id="1790220802326" label="促销策划订购流程_订单处理" tasktype="csf_service" tasktag="_dealOrder">
        <uiinfo>{"x":460,"y":749}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <gotoitem goto="1790220850257" />
        <gotoitem goto="1790220990229" />
    </task>
    <task id="1790220850257" label="预缴策划订购流程_订单处理" tasktype="csf_service" tasktag="_dealOrder">
        <uiinfo>{"x":460,"y":837}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_startWorkflow</servicecode>
            <servicename>startWorkflow</servicename>
        </autodeal>
        <gotoitem goto="1790220990229" />
    </task>
    <task id="1790220990229" label="流程完成处理_订单处理" tasktype="csf_auto" tasktag="complete_dealOrder">
        <uiinfo>{"x":460,"y":925}</uiinfo>
        <user taskusertype="staff" taskuserid="" organizeid="" />
        <autodeal>
            <runtype>csfService</runtype>
            <crossCenter>false</crossCenter>
            <centercode>ord</centercode>
            <servicecode>ord_IOrder4ComframeCSV_finishWorkflowSchedule</servicecode>
            <servicename>finishWorkflowSchedule</servicename>
        </autodeal>
        <relationship>
            <task_>
                <link name="IN">
                    <left>custOrderId</left>
                    <right>custOrderId</right>
                </link>
            </task_>
        </relationship>
        <gotoitem goto="2" />
    </task>
    <join id="vueflow__edge-1-bypass-1790215737919" name="vueflow__edge-1-bypass-1790215737919" taska="1" taskb="1790215737919">
        <uiinfo>[]</uiinfo>
       ',
' <condition />
    </join>
    <join id="vueflow__edge-1790215737919-bypass-1790216116185" name="vueflow__edge-1790215737919-bypass-1790216116185" taska="1790215737919" taskb="1790216116185">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216116185-bypass-1790216516296" name="vueflow__edge-1790216116185-bypass-1790216516296" taska="1790216116185" taskb="1790216516296">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790215737919-bypass-1790216253182" name="vueflow__edge-1790215737919-bypass-1790216253182" taska="1790215737919" taskb="1790216253182">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790215737919-bypass-1790216330779" name="vueflow__edge-1790215737919-bypass-1790216330779" taska="1790215737919" taskb="1790216330779">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790215737919-bypass-1790216397556" name="vueflow__edge-1790215737919-bypass-1790216397556" taska="1790215737919" taskb="1790216397556">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216253182-bypass-1790216330779" name="vueflow__edge-1790216253182-bypass-1790216330779" taska="1790216253182" taskb="1790216330779">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216253182-bypass-1790216397556" name="vueflow__edge-1790216253182-bypass-1790216397556" taska="1790216253182" taskb="1790216397556">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216253182-bypass-1790216516296" name="vueflow__edge-1790216253182-bypass-1790216516296" taska="1790216253182" taskb="1790216516296">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216397556-bypass-1790216516296" name="vueflow__edge-1790216397556-bypass-1790216516296" taska="1790216397556" taskb="1790216516296">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216330779-bypass-1790216397556" name="vueflow__edge-1790216330779-bypass-1790216397556" taska="1790216330779" taskb="1790216397556">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216330779-bypass-1790216516296" name="vueflow__edge-1790216330779-bypass-1790216516296" taska="1790216330779" taskb="1790216516296">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216516296-bypass-1790220539112" name="vueflow__edge-1790216516296-bypass-1790220539112" taska="1790216516296" taskb="1790220539112">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216516296-bypass-1790220704715" name="vueflow__edge-1790216516296-bypass-1790220704715" taska="1790216516296" taskb="1790220704715">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216516296-bypass-1790220802326" name="vueflow__edge-1790216516296-bypass-1790220802326" taska="1790216516296" taskb="1790220802326">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216516296-bypass-1790220850257" name="vueflow__edge-1790216516296-bypass-1790220850257" taska="1790216516296" taskb="1790220850257">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790216516296-bypass-1790220990229" name="vueflow__edge-1790216516296-bypass-1790220990229" taska="1790216516296" taskb="1790220990229">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="',
'vueflow__edge-1790220539112-bypass-1790220704715" name="vueflow__edge-1790220539112-bypass-1790220704715" taska="1790220539112" taskb="1790220704715">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220539112-bypass-1790220802326" name="vueflow__edge-1790220539112-bypass-1790220802326" taska="1790220539112" taskb="1790220802326">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220539112-bypass-1790220850257" name="vueflow__edge-1790220539112-bypass-1790220850257" taska="1790220539112" taskb="1790220850257">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220539112-bypass-1790220990229" name="vueflow__edge-1790220539112-bypass-1790220990229" taska="1790220539112" taskb="1790220990229">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220704715-bypass-1790220802326" name="vueflow__edge-1790220704715-bypass-1790220802326" taska="1790220704715" taskb="1790220802326">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220704715-bypass-1790220850257" name="vueflow__edge-1790220704715-bypass-1790220850257" taska="1790220704715" taskb="1790220850257">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220704715-bypass-1790220990229" name="vueflow__edge-1790220704715-bypass-1790220990229" taska="1790220704715" taskb="1790220990229">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220802326-bypass-1790220850257" name="vueflow__edge-1790220802326-bypass-1790220850257" taska="1790220802326" taskb="1790220850257">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220802326-bypass-1790220990229" name="vueflow__edge-1790220802326-bypass-1790220990229" taska="1790220802326" taskb="1790220990229">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220990229-bypass-2" name="vueflow__edge-1790220990229-bypass-2" taska="1790220990229" taskb="2">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
    <join id="vueflow__edge-1790220850257-bypass-1790220990229" name="vueflow__edge-1790220850257-bypass-1790220990229" taska="1790220850257" taskb="1790220990229">
        <uiinfo>[]</uiinfo>
        <condition />
    </join>
</workflow>',
NULL,
NULL,
NULL,
NULL,
NULL,
NULL,
NULL,
NULL,
NULL,
NULL,
NULL);

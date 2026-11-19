// Generated from Supabase VA (kxlrxqewcnwcstzvyrcr) on 2026-11-16. Do not edit by hand.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      addition_charges: {
        Row: {
          amount: number
          created_at: string
          description: string
          email_error: string | null
          error_log: Json | null
          estimate_email_sent: boolean
          hubspot_deal_id: string
          id: string
          invoice_email_sent: boolean
          invoice_step_status: string
          narration: string | null
          paid_at: string | null
          payment_amount: number | null
          payment_date: string | null
          payment_method: string | null
          payment_narration: string | null
          payment_reference: string | null
          periskope_payment_confirmed_sent: boolean
          periskope_sent: boolean
          periskope_skip_reason: string | null
          razorpay_payment_link_id: string | null
          razorpay_short_url: string | null
          status: string
          updated_at: string
          zoho_estimate_id: string | null
          zoho_estimate_number: string | null
          zoho_estimate_total: number | null
          zoho_invoice_id: string | null
          zoho_invoice_number: string | null
          zoho_payment_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          description: string
          email_error?: string | null
          error_log?: Json | null
          estimate_email_sent?: boolean
          hubspot_deal_id: string
          id?: string
          invoice_email_sent?: boolean
          invoice_step_status?: string
          narration?: string | null
          paid_at?: string | null
          payment_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          payment_narration?: string | null
          payment_reference?: string | null
          periskope_payment_confirmed_sent?: boolean
          periskope_sent?: boolean
          periskope_skip_reason?: string | null
          razorpay_payment_link_id?: string | null
          razorpay_short_url?: string | null
          status?: string
          updated_at?: string
          zoho_estimate_id?: string | null
          zoho_estimate_number?: string | null
          zoho_estimate_total?: number | null
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_payment_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          email_error?: string | null
          error_log?: Json | null
          estimate_email_sent?: boolean
          hubspot_deal_id?: string
          id?: string
          invoice_email_sent?: boolean
          invoice_step_status?: string
          narration?: string | null
          paid_at?: string | null
          payment_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          payment_narration?: string | null
          payment_reference?: string | null
          periskope_payment_confirmed_sent?: boolean
          periskope_sent?: boolean
          periskope_skip_reason?: string | null
          razorpay_payment_link_id?: string | null
          razorpay_short_url?: string | null
          status?: string
          updated_at?: string
          zoho_estimate_id?: string | null
          zoho_estimate_number?: string | null
          zoho_estimate_total?: number | null
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_payment_id?: string | null
        }
        Relationships: []
      }
      client_contacts: {
        Row: {
          client_id: string | null
          contact_id: string
          contact_name: string | null
          created_at: string | null
          is_primary: boolean | null
          role: string | null
          whatsapp_number: string
        }
        Insert: {
          client_id?: string | null
          contact_id?: string
          contact_name?: string | null
          created_at?: string | null
          is_primary?: boolean | null
          role?: string | null
          whatsapp_number: string
        }
        Update: {
          client_id?: string | null
          contact_id?: string
          contact_name?: string | null
          created_at?: string | null
          is_primary?: boolean | null
          role?: string | null
          whatsapp_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_messages: {
        Row: {
          body: string
          body_tsv: unknown
          client_id: string | null
          conversation_id: string | null
          created_at: string | null
          dedup_hash: string
          direction: string | null
          embedding: string | null
          message_id: string
          message_timestamp: string
          message_type: string | null
          processed_at: string | null
          sender_name: string | null
          sender_phone: string | null
          source: string | null
          whatsapp_group_id: string | null
        }
        Insert: {
          body: string
          body_tsv?: unknown
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string | null
          dedup_hash: string
          direction?: string | null
          embedding?: string | null
          message_id?: string
          message_timestamp: string
          message_type?: string | null
          processed_at?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          source?: string | null
          whatsapp_group_id?: string | null
        }
        Update: {
          body?: string
          body_tsv?: unknown
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string | null
          dedup_hash?: string
          direction?: string | null
          embedding?: string | null
          message_id?: string
          message_timestamp?: string
          message_type?: string | null
          processed_at?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          source?: string | null
          whatsapp_group_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversation_response_lags"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "client_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_pricing: {
        Row: {
          auto_quote: boolean
          base_price: number | null
          client_name: string | null
          created_at: string
          deal_name: string | null
          hubspot_deal_id: string
          id: string
          pending_since_override: string | null
          updated_at: string
          zoho_customer_id: string | null
          zoho_customer_name: string | null
        }
        Insert: {
          auto_quote?: boolean
          base_price?: number | null
          client_name?: string | null
          created_at?: string
          deal_name?: string | null
          hubspot_deal_id: string
          id?: string
          pending_since_override?: string | null
          updated_at?: string
          zoho_customer_id?: string | null
          zoho_customer_name?: string | null
        }
        Update: {
          auto_quote?: boolean
          base_price?: number | null
          client_name?: string | null
          created_at?: string
          deal_name?: string | null
          hubspot_deal_id?: string
          id?: string
          pending_since_override?: string | null
          updated_at?: string
          zoho_customer_id?: string | null
          zoho_customer_name?: string | null
        }
        Relationships: []
      }
      client_score_history: {
        Row: {
          client_id: string
          complaints_7d: number
          computed_at: string
          mood_score: number
          open_issues: number
          our_fault_7d: number
          score_date: string
          service_score: number
        }
        Insert: {
          client_id: string
          complaints_7d?: number
          computed_at?: string
          mood_score: number
          open_issues?: number
          our_fault_7d?: number
          score_date: string
          service_score: number
        }
        Update: {
          client_id?: string
          complaints_7d?: number
          computed_at?: string
          mood_score?: number
          open_issues?: number
          our_fault_7d?: number
          score_date?: string
          service_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "client_score_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_score_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_scores: {
        Row: {
          client_id: string
          complaints_7d: number
          computed_at: string
          last_message_at: string | null
          mood_delta: number | null
          mood_score: number
          open_issues: number
          our_fault_7d: number
          prev_mood: number | null
          prev_service: number | null
          service_delta: number | null
          service_score: number
          top_reasons: Json
          unanswered_count: number
          va_id: string | null
          worst_lag_minutes: number | null
        }
        Insert: {
          client_id: string
          complaints_7d?: number
          computed_at?: string
          last_message_at?: string | null
          mood_delta?: number | null
          mood_score: number
          open_issues?: number
          our_fault_7d?: number
          prev_mood?: number | null
          prev_service?: number | null
          service_delta?: number | null
          service_score: number
          top_reasons?: Json
          unanswered_count?: number
          va_id?: string | null
          worst_lag_minutes?: number | null
        }
        Update: {
          client_id?: string
          complaints_7d?: number
          computed_at?: string
          last_message_at?: string | null
          mood_delta?: number | null
          mood_score?: number
          open_issues?: number
          our_fault_7d?: number
          prev_mood?: number | null
          prev_service?: number | null
          service_delta?: number | null
          service_score?: number
          top_reasons?: Json
          unanswered_count?: number
          va_id?: string | null
          worst_lag_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_scores_va_id_fkey"
            columns: ["va_id"]
            isOneToOne: false
            referencedRelation: "vas"
            referencedColumns: ["va_id"]
          },
        ]
      }
      clients: {
        Row: {
          amount_paid: number | null
          assigned_va: string | null
          city: string | null
          client_id: string
          client_name: string
          council_enabled: boolean
          created_at: string | null
          deal_stage: string | null
          drive_folder_id: string | null
          email: string | null
          entity_type: string | null
          gstin: string | null
          hubspot_deal_id: string | null
          industry: string | null
          legal_name: string | null
          onboarding_date: string | null
          ot_amount: number | null
          ot_payment_date: string | null
          pan: string | null
          parent_client_id: string | null
          state: string | null
          status: string | null
          va_id: string | null
          whatsapp_group_id: string | null
          whatsapp_group_name: string | null
        }
        Insert: {
          amount_paid?: number | null
          assigned_va?: string | null
          city?: string | null
          client_id?: string
          client_name: string
          council_enabled?: boolean
          created_at?: string | null
          deal_stage?: string | null
          drive_folder_id?: string | null
          email?: string | null
          entity_type?: string | null
          gstin?: string | null
          hubspot_deal_id?: string | null
          industry?: string | null
          legal_name?: string | null
          onboarding_date?: string | null
          ot_amount?: number | null
          ot_payment_date?: string | null
          pan?: string | null
          parent_client_id?: string | null
          state?: string | null
          status?: string | null
          va_id?: string | null
          whatsapp_group_id?: string | null
          whatsapp_group_name?: string | null
        }
        Update: {
          amount_paid?: number | null
          assigned_va?: string | null
          city?: string | null
          client_id?: string
          client_name?: string
          council_enabled?: boolean
          created_at?: string | null
          deal_stage?: string | null
          drive_folder_id?: string | null
          email?: string | null
          entity_type?: string | null
          gstin?: string | null
          hubspot_deal_id?: string | null
          industry?: string | null
          legal_name?: string | null
          onboarding_date?: string | null
          ot_amount?: number | null
          ot_payment_date?: string | null
          pan?: string | null
          parent_client_id?: string | null
          state?: string | null
          status?: string | null
          va_id?: string | null
          whatsapp_group_id?: string | null
          whatsapp_group_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_parent_client_id_fkey"
            columns: ["parent_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "clients_parent_client_id_fkey"
            columns: ["parent_client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "clients_va_id_fkey"
            columns: ["va_id"]
            isOneToOne: false
            referencedRelation: "vas"
            referencedColumns: ["va_id"]
          },
        ]
      }
      conversations: {
        Row: {
          client_id: string
          client_tone: string | null
          closed_at: string | null
          created_at: string
          fault: string | null
          id: string
          last_message_at: string
          last_message_direction: string | null
          message_count: number
          opened_at: string
          opened_by: string
          sla_breached: boolean
          status: string
          summary: string
          tag: string | null
          title: string | null
          updated_at: string
          va_id: string | null
          va_tone: string | null
        }
        Insert: {
          client_id: string
          client_tone?: string | null
          closed_at?: string | null
          created_at?: string
          fault?: string | null
          id?: string
          last_message_at?: string
          last_message_direction?: string | null
          message_count?: number
          opened_at?: string
          opened_by: string
          sla_breached?: boolean
          status?: string
          summary?: string
          tag?: string | null
          title?: string | null
          updated_at?: string
          va_id?: string | null
          va_tone?: string | null
        }
        Update: {
          client_id?: string
          client_tone?: string | null
          closed_at?: string | null
          created_at?: string
          fault?: string | null
          id?: string
          last_message_at?: string
          last_message_direction?: string | null
          message_count?: number
          opened_at?: string
          opened_by?: string
          sla_breached?: boolean
          status?: string
          summary?: string
          tag?: string | null
          title?: string | null
          updated_at?: string
          va_id?: string | null
          va_tone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "conversations_va_id_fkey"
            columns: ["va_id"]
            isOneToOne: false
            referencedRelation: "vas"
            referencedColumns: ["va_id"]
          },
        ]
      }
      council_verdicts: {
        Row: {
          agreed: boolean | null
          claude_decision: string
          claude_latency_ms: number | null
          claude_model: string
          claude_reasoning: string | null
          claude_target_conv_id: string | null
          created_at: string
          final_conv_id: string | null
          final_decision: string
          gpt_decision: string
          gpt_latency_ms: number | null
          gpt_model: string
          gpt_reasoning: string | null
          gpt_target_conv_id: string | null
          id: string
          message_id: string
        }
        Insert: {
          agreed?: boolean | null
          claude_decision: string
          claude_latency_ms?: number | null
          claude_model: string
          claude_reasoning?: string | null
          claude_target_conv_id?: string | null
          created_at?: string
          final_conv_id?: string | null
          final_decision: string
          gpt_decision: string
          gpt_latency_ms?: number | null
          gpt_model: string
          gpt_reasoning?: string | null
          gpt_target_conv_id?: string | null
          id?: string
          message_id: string
        }
        Update: {
          agreed?: boolean | null
          claude_decision?: string
          claude_latency_ms?: number | null
          claude_model?: string
          claude_reasoning?: string | null
          claude_target_conv_id?: string | null
          created_at?: string
          final_conv_id?: string | null
          final_decision?: string
          gpt_decision?: string
          gpt_latency_ms?: number | null
          gpt_model?: string
          gpt_reasoning?: string | null
          gpt_target_conv_id?: string | null
          id?: string
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "council_verdicts_claude_target_conv_id_fkey"
            columns: ["claude_target_conv_id"]
            isOneToOne: false
            referencedRelation: "conversation_response_lags"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "council_verdicts_claude_target_conv_id_fkey"
            columns: ["claude_target_conv_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "council_verdicts_final_conv_id_fkey"
            columns: ["final_conv_id"]
            isOneToOne: false
            referencedRelation: "conversation_response_lags"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "council_verdicts_final_conv_id_fkey"
            columns: ["final_conv_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "council_verdicts_gpt_target_conv_id_fkey"
            columns: ["gpt_target_conv_id"]
            isOneToOne: false
            referencedRelation: "conversation_response_lags"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "council_verdicts_gpt_target_conv_id_fkey"
            columns: ["gpt_target_conv_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "council_verdicts_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "client_messages"
            referencedColumns: ["message_id"]
          },
        ]
      }
      document_uploads: {
        Row: {
          client_id: string | null
          client_name: string
          file_name: string | null
          file_size: number | null
          file_type: string | null
          folder_name: string
          group_id: string | null
          group_name: string | null
          notified: boolean | null
          sender_phone: string | null
          upload_id: string
          uploaded_at: string | null
        }
        Insert: {
          client_id?: string | null
          client_name: string
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          folder_name: string
          group_id?: string | null
          group_name?: string | null
          notified?: boolean | null
          sender_phone?: string | null
          upload_id?: string
          uploaded_at?: string | null
        }
        Update: {
          client_id?: string | null
          client_name?: string
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          folder_name?: string
          group_id?: string | null
          group_name?: string | null
          notified?: boolean | null
          sender_phone?: string | null
          upload_id?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "document_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
      // Added by hand from supabase/applied/2026-11-18-follow-ups.sql until the types are regenerated.
      follow_ups: {
        Row: {
          client_id: string
          conversation_id: string | null
          created_at: string
          due_at: string | null
          escalated_at: string | null
          id: string
          item: string
          kind: string
          last_reminded_at: string | null
          reminder_count: number
          resolved_at: string | null
          resolved_by: string | null
          resolved_message_id: string | null
          resolved_upload_id: string | null
          source_message_id: string
          status: string
        }
        Insert: {
          client_id: string
          conversation_id?: string | null
          created_at?: string
          due_at?: string | null
          escalated_at?: string | null
          id?: string
          item: string
          kind: string
          last_reminded_at?: string | null
          reminder_count?: number
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_message_id?: string | null
          resolved_upload_id?: string | null
          source_message_id: string
          status?: string
        }
        Update: {
          client_id?: string
          conversation_id?: string | null
          created_at?: string
          due_at?: string | null
          escalated_at?: string | null
          id?: string
          item?: string
          kind?: string
          last_reminded_at?: string | null
          reminder_count?: number
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_message_id?: string | null
          resolved_upload_id?: string | null
          source_message_id?: string
          status?: string
        }
        Relationships: []
      }
      flagged_messages: {
        Row: {
          body: string | null
          chat_id: string | null
          client_id: string | null
          client_name: string | null
          flagged_at: string | null
          message_id: string
          notified_at: string | null
          sender_phone: string | null
        }
        Insert: {
          body?: string | null
          chat_id?: string | null
          client_id?: string | null
          client_name?: string | null
          flagged_at?: string | null
          message_id: string
          notified_at?: string | null
          sender_phone?: string | null
        }
        Update: {
          body?: string | null
          chat_id?: string | null
          client_id?: string | null
          client_name?: string | null
          flagged_at?: string | null
          message_id?: string
          notified_at?: string | null
          sender_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flagged_messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "flagged_messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
      invoices: {
        Row: {
          account_number: string | null
          amount: number | null
          bank_name: string | null
          company_name: string | null
          created_at: string | null
          document_type: string | null
          error: string | null
          id: number
          ifsc: string | null
          invoice_date: string | null
          invoice_number: string | null
          invoice_received_date: string | null
          message_id: string | null
          net_amount: number | null
          payment_date: string | null
          status: string | null
          tds_amount: number | null
          vendor: string | null
          vendor_bank_name: string | null
        }
        Insert: {
          account_number?: string | null
          amount?: number | null
          bank_name?: string | null
          company_name?: string | null
          created_at?: string | null
          document_type?: string | null
          error?: string | null
          id?: number
          ifsc?: string | null
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_received_date?: string | null
          message_id?: string | null
          net_amount?: number | null
          payment_date?: string | null
          status?: string | null
          tds_amount?: number | null
          vendor?: string | null
          vendor_bank_name?: string | null
        }
        Update: {
          account_number?: string | null
          amount?: number | null
          bank_name?: string | null
          company_name?: string | null
          created_at?: string | null
          document_type?: string | null
          error?: string | null
          id?: number
          ifsc?: string | null
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_received_date?: string | null
          message_id?: string | null
          net_amount?: number | null
          payment_date?: string | null
          status?: string | null
          tds_amount?: number | null
          vendor?: string | null
          vendor_bank_name?: string | null
        }
        Relationships: []
      }
      message_processing_log: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          max_attempts: number
          message_id: string
          processed_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          max_attempts?: number
          message_id: string
          processed_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          max_attempts?: number
          message_id?: string
          processed_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_processing_log_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "client_messages"
            referencedColumns: ["message_id"]
          },
        ]
      }
      release_note_sends: {
        Row: {
          account_status: string | null
          company_name: string | null
          created_at: string | null
          csm_in_group: string | null
          csm_owner: string | null
          csm_phone: string | null
          error_detail: string | null
          gm_phone: string | null
          hubspot_deal_id: string | null
          id: string
          queue_id: string | null
          scheduled_at: string | null
          send_day: number | null
          sent_at: string | null
          status: string | null
          unique_id: string | null
          variant: number | null
          whatsapp_group_id: string | null
        }
        Insert: {
          account_status?: string | null
          company_name?: string | null
          created_at?: string | null
          csm_in_group?: string | null
          csm_owner?: string | null
          csm_phone?: string | null
          error_detail?: string | null
          gm_phone?: string | null
          hubspot_deal_id?: string | null
          id: string
          queue_id?: string | null
          scheduled_at?: string | null
          send_day?: number | null
          sent_at?: string | null
          status?: string | null
          unique_id?: string | null
          variant?: number | null
          whatsapp_group_id?: string | null
        }
        Update: {
          account_status?: string | null
          company_name?: string | null
          created_at?: string | null
          csm_in_group?: string | null
          csm_owner?: string | null
          csm_phone?: string | null
          error_detail?: string | null
          gm_phone?: string | null
          hubspot_deal_id?: string | null
          id?: string
          queue_id?: string | null
          scheduled_at?: string | null
          send_day?: number | null
          sent_at?: string | null
          status?: string | null
          unique_id?: string | null
          variant?: number | null
          whatsapp_group_id?: string | null
        }
        Relationships: []
      }
      renewal_jobs: {
        Row: {
          billed_price: number | null
          billing_period: string
          created_at: string
          email_error: string | null
          error_log: Json | null
          estimate_email_sent: boolean
          hubspot_deal_id: string
          hubspot_line_item_id: string | null
          hubspot_renewal_done: boolean
          hubspot_updated: boolean
          id: string
          invoice_email_sent: boolean
          invoice_step_status: string
          paid_at: string | null
          payment_amount: number | null
          payment_date: string | null
          payment_method: string | null
          payment_narration: string | null
          payment_reference: string | null
          periskope_payment_confirmed_sent: boolean
          periskope_sent: boolean
          periskope_skip_reason: string | null
          razorpay_payment_link_id: string | null
          razorpay_short_url: string | null
          razorpay_step_status: string
          reminder_1_sent_at: string | null
          reminder_2_sent_at: string | null
          reminder_3_sent_at: string | null
          reminder_skip_reason: string | null
          service_period_start: string | null
          status: string
          term_months: number | null
          updated_at: string
          zoho_estimate_id: string | null
          zoho_estimate_number: string | null
          zoho_estimate_total: number | null
          zoho_invoice_id: string | null
          zoho_invoice_number: string | null
          zoho_payment_id: string | null
          zoho_step_status: string
        }
        Insert: {
          billed_price?: number | null
          billing_period: string
          created_at?: string
          email_error?: string | null
          error_log?: Json | null
          estimate_email_sent?: boolean
          hubspot_deal_id: string
          hubspot_line_item_id?: string | null
          hubspot_renewal_done?: boolean
          hubspot_updated?: boolean
          id?: string
          invoice_email_sent?: boolean
          invoice_step_status?: string
          paid_at?: string | null
          payment_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          payment_narration?: string | null
          payment_reference?: string | null
          periskope_payment_confirmed_sent?: boolean
          periskope_sent?: boolean
          periskope_skip_reason?: string | null
          razorpay_payment_link_id?: string | null
          razorpay_short_url?: string | null
          razorpay_step_status?: string
          reminder_1_sent_at?: string | null
          reminder_2_sent_at?: string | null
          reminder_3_sent_at?: string | null
          reminder_skip_reason?: string | null
          service_period_start?: string | null
          status?: string
          term_months?: number | null
          updated_at?: string
          zoho_estimate_id?: string | null
          zoho_estimate_number?: string | null
          zoho_estimate_total?: number | null
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_payment_id?: string | null
          zoho_step_status?: string
        }
        Update: {
          billed_price?: number | null
          billing_period?: string
          created_at?: string
          email_error?: string | null
          error_log?: Json | null
          estimate_email_sent?: boolean
          hubspot_deal_id?: string
          hubspot_line_item_id?: string | null
          hubspot_renewal_done?: boolean
          hubspot_updated?: boolean
          id?: string
          invoice_email_sent?: boolean
          invoice_step_status?: string
          paid_at?: string | null
          payment_amount?: number | null
          payment_date?: string | null
          payment_method?: string | null
          payment_narration?: string | null
          payment_reference?: string | null
          periskope_payment_confirmed_sent?: boolean
          periskope_sent?: boolean
          periskope_skip_reason?: string | null
          razorpay_payment_link_id?: string | null
          razorpay_short_url?: string | null
          razorpay_step_status?: string
          reminder_1_sent_at?: string | null
          reminder_2_sent_at?: string | null
          reminder_3_sent_at?: string | null
          reminder_skip_reason?: string | null
          service_period_start?: string | null
          status?: string
          term_months?: number | null
          updated_at?: string
          zoho_estimate_id?: string | null
          zoho_estimate_number?: string | null
          zoho_estimate_total?: number | null
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_payment_id?: string | null
          zoho_step_status?: string
        }
        Relationships: []
      }
      score_weights: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: number
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: number
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: number
        }
        Relationships: []
      }
      settings: {
        Row: {
          key: string
          note: string | null
          value: string
        }
        Insert: {
          key: string
          note?: string | null
          value: string
        }
        Update: {
          key?: string
          note?: string | null
          value?: string
        }
        Relationships: []
      }
      // Added by hand from supabase/applied/2026-11-18-teams-notifications.sql until the types are regenerated.
      teams_notifications: {
        Row: {
          action: string | null
          action_at: string | null
          action_by: string | null
          activity_id: string | null
          channel_id: string
          client_id: string | null
          id: string
          kind: string
          ref_id: string
          sent_at: string
        }
        Insert: {
          action?: string | null
          action_at?: string | null
          action_by?: string | null
          activity_id?: string | null
          channel_id: string
          client_id?: string | null
          id?: string
          kind: string
          ref_id: string
          sent_at?: string
        }
        Update: {
          action?: string | null
          action_at?: string | null
          action_by?: string | null
          activity_id?: string | null
          channel_id?: string
          client_id?: string | null
          id?: string
          kind?: string
          ref_id?: string
          sent_at?: string
        }
        Relationships: []
      }
      // Added by hand from supabase/applied/2026-11-19-teams-chat.sql until the types are regenerated.
      teams_chat: {
        Row: {
          content: string
          created_at: string
          id: string
          kind: string
          meta: Json | null
          user_email: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          kind: string
          meta?: Json | null
          user_email: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          kind?: string
          meta?: Json | null
          user_email?: string
        }
        Relationships: []
      }
      va_meeting_transcripts: {
        Row: {
          all_attendees: Json | null
          client_id: string | null
          contact_source: string | null
          created_at: string | null
          hubspot_contact_id: string | null
          hubspot_deal_id: string | null
          ical_uid: string
          id: string
          meeting_date: string | null
          meeting_duration_minutes: number | null
          meeting_end: string | null
          meeting_start: string | null
          meeting_type: string | null
          organizer_email: string | null
          organizer_name: string | null
          poc_email: string | null
          poc_name: string | null
          subject: string | null
          teams_url: string | null
          transcript: string | null
          transcript_status: string | null
        }
        Insert: {
          all_attendees?: Json | null
          client_id?: string | null
          contact_source?: string | null
          created_at?: string | null
          hubspot_contact_id?: string | null
          hubspot_deal_id?: string | null
          ical_uid: string
          id?: string
          meeting_date?: string | null
          meeting_duration_minutes?: number | null
          meeting_end?: string | null
          meeting_start?: string | null
          meeting_type?: string | null
          organizer_email?: string | null
          organizer_name?: string | null
          poc_email?: string | null
          poc_name?: string | null
          subject?: string | null
          teams_url?: string | null
          transcript?: string | null
          transcript_status?: string | null
        }
        Update: {
          all_attendees?: Json | null
          client_id?: string | null
          contact_source?: string | null
          created_at?: string | null
          hubspot_contact_id?: string | null
          hubspot_deal_id?: string | null
          ical_uid?: string
          id?: string
          meeting_date?: string | null
          meeting_duration_minutes?: number | null
          meeting_end?: string | null
          meeting_start?: string | null
          meeting_type?: string | null
          organizer_email?: string | null
          organizer_name?: string | null
          poc_email?: string | null
          poc_name?: string | null
          subject?: string | null
          teams_url?: string | null
          transcript?: string | null
          transcript_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "va_meeting_transcripts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "va_meeting_transcripts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
      vas: {
        Row: {
          client_count: number | null
          contract_end_date: string | null
          email: string | null
          status: string | null
          teams_chat_id: string | null
          teams_user_id: string | null
          va_id: string
          va_name: string
          whatsapp_number: string | null
        }
        Insert: {
          client_count?: number | null
          contract_end_date?: string | null
          email?: string | null
          status?: string | null
          teams_chat_id?: string | null
          teams_user_id?: string | null
          va_id?: string
          va_name: string
          whatsapp_number?: string | null
        }
        Update: {
          client_count?: number | null
          contract_end_date?: string | null
          email?: string | null
          status?: string | null
          teams_chat_id?: string | null
          teams_user_id?: string | null
          va_id?: string
          va_name?: string
          whatsapp_number?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      clients_meeting_picker: {
        Row: {
          client_id: string | null
          client_name: string | null
          email: string | null
        }
        Insert: {
          client_id?: string | null
          client_name?: string | null
          email?: string | null
        }
        Update: {
          client_id?: string | null
          client_name?: string | null
          email?: string | null
        }
        Relationships: []
      }
      conversation_response_lags: {
        Row: {
          awaiting_reply: boolean | null
          client_id: string | null
          conversation_id: string | null
          current_lag_minutes: number | null
          first_response_at: string | null
          first_response_lag_minutes: number | null
          last_message_at: string | null
          last_message_direction: string | null
          opened_at: string | null
          opened_by: string | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients_meeting_picker"
            referencedColumns: ["client_id"]
          },
        ]
      }
    }
    Functions: {
      kb_decrypt_secret: {
        Args: { p_ciphertext: string; p_key: string }
        Returns: string
      }
      kb_encrypt_secret: {
        Args: { p_key: string; p_plaintext: string }
        Returns: string
      }
      kb_upsert_credential: {
        Args: {
          p_change_source?: string
          p_changed_by?: string
          p_client_id: string
          p_context: string
          p_key: string
          p_new_password: string
          p_source_message_id: string
          p_system_name: string
          p_username: string
        }
        Returns: {
          action: string
          credential_id: string
          history_written: boolean
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
